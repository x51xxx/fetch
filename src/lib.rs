#![deny(clippy::all)]

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use wreq::cookie::Jar;
use wreq::tls::TlsVersion;
use wreq::{Client, IntoEmulation, Method, Proxy, Uri};
use wreq_util::{Emulation as EmulationProfile, Platform, Profile};

/// Raw ClientHello-level overrides, applied on top of whatever `impersonate`
/// resolves to. **Setting any of these moves the fingerprint away from the
/// `impersonate` profile's own values** — the whole point of `impersonate`
/// is that wreq-util picked these to match a real browser byte-for-byte.
/// Mirrors what curl-impersonate's own wrapper scripts expose
/// (`--ciphers`, `--curves`, `--tls-permute-extensions`), not the full
/// ~25-field BoringSSL option set (ECH GREASE, delegated credentials, PSK,
/// key shares are intentionally left out: they drift across wreq releases
/// and are rarely hand-tuned in practice).
#[derive(Clone, PartialEq, Eq, Hash)]
struct TlsOptionsKey {
    cipher_list: Option<String>,
    curves_list: Option<String>,
    sigalgs_list: Option<String>,
    permute_extensions: Option<bool>,
    session_ticket: Option<bool>,
}

/// Identifies a distinct underlying `wreq::Client`. Two calls with equal keys
/// share a client and its connection pool; unequal keys get isolated clients.
/// The persistent cookie jar is deliberately NOT per-key: it's keyed by the
/// `session` id alone (see `session_jar`), so cookies follow a session across
/// fingerprint settings and `resolve` one-off clients, while two different
/// `session` ids still never see each other's cookies.
#[derive(Clone, PartialEq, Eq, Hash)]
struct ClientKey {
    impersonate: String,
    platform: Option<String>,
    session: Option<String>,
    tls_min_version: Option<String>,
    tls_max_version: Option<String>,
    http_version: Option<String>,
    tls_options: Option<TlsOptionsKey>,
}

struct ResolveOverride {
    host: String,
    addrs: Vec<SocketAddr>,
}

struct SelectedResolve<'a> {
    port_specific: bool,
    key: &'a str,
    value: &'a Either<String, Vec<String>>,
}

struct CachedClient {
    client: Client,
    last_used: Instant,
}

type ClientCache = Mutex<HashMap<ClientKey, CachedClient>>;

static CLIENTS: OnceLock<ClientCache> = OnceLock::new();

/// Bound the process-wide cache even when callers pass arbitrary session ids
/// or TLS overrides. Evicted clients are dropped; in-flight requests keep the
/// clone they already received.
const MAX_CACHED_CLIENTS: usize = 256;

struct SessionJar {
    jar: Arc<Jar>,
    last_used: Instant,
}

type SessionJarMap = Mutex<HashMap<String, SessionJar>>;

static SESSION_JARS: OnceLock<SessionJarMap> = OnceLock::new();

/// Same scale as the client cache: live jars are the ones cached clients (or
/// in-flight requests) still reference, and those are bounded by
/// `MAX_CACHED_CLIENTS`.
const MAX_SESSION_JARS: usize = MAX_CACHED_CLIENTS;

/// A buffered API still needs a hard ceiling to avoid an untrusted response
/// exhausting the Node process. Callers can lower or raise this per request.
const DEFAULT_MAX_RESPONSE_BYTES: u32 = 32 * 1024 * 1024;

/// Default browser fingerprint used when `impersonate` is not supplied.
const DEFAULT_IMPERSONATE: &str = "chrome_147";

struct CurlImpersonatePreset {
    /// Name of the wrapper script in https://github.com/lwthiker/curl-impersonate
    /// (`curl_<name>`), taken verbatim from that project's `browsers.json`.
    name: &'static str,
    profile: Profile,
    platform: Platform,
    /// Browser version curl-impersonate pinned this preset to.
    browser_version: &'static str,
    /// `true` if wreq-util ships a profile for this exact browser version.
    /// `false` means curl-impersonate's version predates wreq-util's oldest
    /// profile for that browser family, so this maps to the closest
    /// (oldest available) newer profile instead of a byte-exact match.
    exact: bool,
}

/// All 19 presets from curl-impersonate's `browsers.json` (as of the version
/// checked), mapped onto the closest wreq-util `Profile`/`Platform` pair.
/// wreq-util's oldest profiles are Chrome100/Edge101/Firefox109, so
/// pre-2022 curl-impersonate presets (chrome99, edge99, ff91esr..ff102) are
/// approximated with the oldest available profile rather than dropped.
const CURL_IMPERSONATE_PRESETS: &[CurlImpersonatePreset] = &[
    CurlImpersonatePreset {
        name: "chrome99",
        profile: Profile::Chrome100,
        platform: Platform::Windows,
        browser_version: "99.0.4844.51",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "chrome100",
        profile: Profile::Chrome100,
        platform: Platform::Windows,
        browser_version: "100.0.4896.127",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome101",
        profile: Profile::Chrome101,
        platform: Platform::Windows,
        browser_version: "101.0.4951.67",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome104",
        profile: Profile::Chrome104,
        platform: Platform::Windows,
        browser_version: "104.0.5112.81",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome107",
        profile: Profile::Chrome107,
        platform: Platform::Windows,
        browser_version: "107.0.5304.107",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome110",
        profile: Profile::Chrome110,
        platform: Platform::Windows,
        browser_version: "110.0.5481.177",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome116",
        profile: Profile::Chrome116,
        platform: Platform::Windows,
        browser_version: "116.0.5845.180",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "chrome99_android",
        profile: Profile::Chrome100,
        platform: Platform::Android,
        browser_version: "99.0.4844.73",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "edge99",
        profile: Profile::Edge101,
        platform: Platform::Windows,
        browser_version: "99.0.1150.30",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "edge101",
        profile: Profile::Edge101,
        platform: Platform::Windows,
        browser_version: "101.0.1210.47",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "ff91esr",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "91.6.0esr",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "ff95",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "95.0.2",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "ff98",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "98.0",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "ff100",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "100.0",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "ff102",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "102.0",
        exact: false,
    },
    CurlImpersonatePreset {
        name: "ff109",
        profile: Profile::Firefox109,
        platform: Platform::Windows,
        browser_version: "109.0",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "ff117",
        profile: Profile::Firefox117,
        platform: Platform::Windows,
        browser_version: "117.0.1",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "safari15_3",
        profile: Profile::Safari15_3,
        platform: Platform::MacOS,
        browser_version: "15.3",
        exact: true,
    },
    CurlImpersonatePreset {
        name: "safari15_5",
        profile: Profile::Safari15_5,
        platform: Platform::MacOS,
        browser_version: "15.5",
        exact: true,
    },
];

fn find_curl_impersonate_preset(name: &str) -> Option<&'static CurlImpersonatePreset> {
    CURL_IMPERSONATE_PRESETS.iter().find(|p| p.name == name)
}

fn profile_name(profile: Profile) -> String {
    match serde_json::to_value(profile) {
        Ok(serde_json::Value::String(s)) => s,
        _ => format!("{profile:?}"),
    }
}

fn platform_name(platform: Platform) -> String {
    match serde_json::to_value(platform) {
        Ok(serde_json::Value::String(s)) => s,
        _ => format!("{platform:?}"),
    }
}

fn client_cache() -> &'static ClientCache {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_client_cache() -> Result<MutexGuard<'static, HashMap<ClientKey, CachedClient>>> {
    client_cache().lock().map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "client cache is unavailable because a previous operation panicked",
        )
    })
}

fn lock_session_jars() -> Result<MutexGuard<'static, HashMap<String, SessionJar>>> {
    SESSION_JARS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "session jar map is unavailable because a previous operation panicked",
            )
        })
}

/// One cookie jar per session id, shared by every client built for that
/// session — the cached per-`ClientKey` clients and the one-off clients built
/// for `resolve` requests — so cookies follow the session the way they follow
/// a browser tab. Lock order: this may be called while the client cache lock
/// is held (client cache → session jars); nothing locks in the other
/// direction.
fn session_jar(session: &str) -> Result<Arc<Jar>> {
    let mut jars = lock_session_jars()?;
    if let Some(entry) = jars.get_mut(session) {
        entry.last_used = Instant::now();
        return Ok(entry.jar.clone());
    }

    if jars.len() >= MAX_SESSION_JARS {
        // Only evict jars no live client references (strong count 1 means the
        // map holds the last Arc): dropping a referenced jar would silently
        // fork that session's cookies between old and new clients. If every
        // jar is referenced the map grows past the soft bound instead; live
        // references are themselves bounded by the client cache.
        if let Some(oldest_key) = jars
            .iter()
            .filter(|(_, entry)| Arc::strong_count(&entry.jar) == 1)
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        {
            jars.remove(&oldest_key);
        }
    }

    let jar = Arc::new(Jar::default());
    jars.insert(
        session.to_string(),
        SessionJar {
            jar: jar.clone(),
            last_used: Instant::now(),
        },
    );
    Ok(jar)
}

fn parse_platform(name: &str) -> Result<Platform> {
    match name {
        "windows" => Ok(Platform::Windows),
        "macos" => Ok(Platform::MacOS),
        "linux" => Ok(Platform::Linux),
        "android" => Ok(Platform::Android),
        "ios" => Ok(Platform::IOS),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("unsupported platform '{other}', expected one of \"windows\", \"macos\", \"linux\", \"android\", \"ios\""),
        )),
    }
}

/// Resolves an `impersonate` name (plus an optional `platform` override) to
/// the full `wreq::Emulation` config (TLS/HTTP1/HTTP2 options + headers) that
/// `.tls_options` overrides then mutate in place, so returning the
/// fully-converted type here — rather than the `wreq_util::Emulation`
/// *selector* — is what makes those overrides possible without redoing the
/// profile→config conversion ourselves.
///
/// Unlike `tls_options`, overriding `platform` does **not** diverge the TLS
/// fingerprint: wreq-util's `Platform` only changes platform-specific
/// headers/User-Agent, not `tls_options`/`http2_options` — see its doc
/// comment. That's what makes it safe to use for OS coherence (e.g. running
/// in a Linux container and wanting the declared platform to say "Linux"
/// too) without the "this diverges the fingerprint" caveat `tls_options` has.
fn resolve_emulation(name: &str, platform_override: Option<Platform>) -> Result<wreq::Emulation> {
    if let Some(preset) = find_curl_impersonate_preset(name) {
        return Ok(EmulationProfile::builder()
            .profile(preset.profile)
            .platform(platform_override.unwrap_or(preset.platform))
            .build()
            .into_emulation());
    }

    match name {
        // `platform` has no effect on random/weighted_random: `Emulation`'s
        // `profile`/`platform` fields are private, so there's no way to pull
        // the profile a random pick landed on back out and rebuild it with a
        // different platform. weighted_random() already only pairs profiles
        // with platforms they realistically ship on, so this isn't a big loss.
        "random" => Ok(EmulationProfile::random().into_emulation()),
        "weighted_random" => Ok(EmulationProfile::weighted_random().into_emulation()),
        other => {
            let profile: Profile = serde_json::from_value(serde_json::Value::String(
                other.to_string(),
            ))
            .map_err(|e| {
                Error::new(
                    Status::InvalidArg,
                    format!("unknown impersonate profile '{other}': {e}"),
                )
            })?;
            match platform_override {
                Some(platform) => Ok(EmulationProfile::builder()
                    .profile(profile)
                    .platform(platform)
                    .build()
                    .into_emulation()),
                None => Ok(profile.into_emulation()),
            }
        }
    }
}

fn parse_tls_version(version: &str) -> Result<TlsVersion> {
    match version {
        "1.0" => Ok(TlsVersion::TLS_1_0),
        "1.1" => Ok(TlsVersion::TLS_1_1),
        "1.2" => Ok(TlsVersion::TLS_1_2),
        "1.3" => Ok(TlsVersion::TLS_1_3),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("unsupported tlsMinVersion/tlsMaxVersion '{other}', expected one of \"1.0\", \"1.1\", \"1.2\", \"1.3\""),
        )),
    }
}

/// Maps the WHATWG redirect mode onto a per-request `wreq` redirect policy.
/// `None` means "no override": the request keeps the client's default
/// follow policy, so plain calls don't pay for a request-config entry.
fn parse_redirect_policy(redirect: Option<&str>) -> Result<Option<wreq::redirect::Policy>> {
    match redirect {
        None | Some("follow") => Ok(None),
        Some("manual") => Ok(Some(wreq::redirect::Policy::none())),
        Some("error") => Ok(Some(wreq::redirect::Policy::custom(|attempt| {
            attempt.error("redirect encountered while redirect mode is 'error'")
        }))),
        Some(other) => Err(Error::new(
            Status::InvalidArg,
            format!(
                "unsupported redirect '{other}', expected one of \"follow\", \"manual\", \"error\""
            ),
        )),
    }
}

fn parse_resolve_key(key: &str) -> Result<(&str, Option<u16>)> {
    if key.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "resolve keys must not be empty",
        ));
    }

    if let Some(bracketed) = key.strip_prefix('[') {
        let close = bracketed.find(']').ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("invalid resolve key '{key}': missing closing ']'"),
            )
        })?;
        let host = &bracketed[..close];
        host.parse::<IpAddr>().map_err(|e| {
            Error::new(
                Status::InvalidArg,
                format!("invalid IPv6 host in resolve key '{key}': {e}"),
            )
        })?;
        let remainder = &bracketed[close + 1..];
        let port = if remainder.is_empty() {
            None
        } else {
            let raw_port = remainder.strip_prefix(':').ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("invalid resolve key '{key}', expected '[host]' or '[host]:port'"),
                )
            })?;
            Some(parse_resolve_port(key, raw_port)?)
        };
        return Ok((host, port));
    }

    // An unbracketed IPv6 literal is a host-only key. Brackets are required
    // only when a port is appended, matching URL authority syntax.
    if key.parse::<IpAddr>().is_ok() {
        return Ok((key, None));
    }

    if let Some((host, raw_port)) = key.rsplit_once(':') {
        if host.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("invalid resolve key '{key}': host must not be empty"),
            ));
        }
        return Ok((host, Some(parse_resolve_port(key, raw_port)?)));
    }

    Ok((key, None))
}

fn parse_resolve_port(key: &str, port: &str) -> Result<u16> {
    port.parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("invalid port in resolve key '{key}', expected 1..65535"),
            )
        })
}

fn select_resolve_override(
    url: &str,
    resolve: &HashMap<String, Either<String, Vec<String>>>,
) -> Result<Option<ResolveOverride>> {
    let uri: Uri = url.parse().map_err(|e| {
        Error::new(
            Status::InvalidArg,
            format!("invalid URL for resolve matching: {e}"),
        )
    })?;
    let raw_request_host = uri
        .host()
        .ok_or_else(|| Error::new(Status::InvalidArg, "resolve requires a URL with a hostname"))?;
    let request_host = raw_request_host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(raw_request_host);
    let request_port = uri.port_u16().or_else(|| match uri.scheme_str() {
        Some("http") => Some(80),
        Some("https") => Some(443),
        _ => None,
    });

    let mut selected: Option<SelectedResolve<'_>> = None;
    for (key, value) in resolve {
        let (host, port) = parse_resolve_key(key)?;
        if !host.eq_ignore_ascii_case(request_host) || port.is_some() && port != request_port {
            continue;
        }

        let is_port_specific = port.is_some();
        if selected
            .as_ref()
            .is_none_or(|current| is_port_specific && !current.port_specific)
        {
            selected = Some(SelectedResolve {
                port_specific: is_port_specific,
                key,
                value,
            });
        }
    }

    let Some(selected) = selected else {
        return Ok(None);
    };
    let raw_addrs = match selected.value {
        Either::A(ip) => std::slice::from_ref(ip),
        Either::B(ips) => ips.as_slice(),
    };
    if raw_addrs.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "resolve entry '{}' must contain at least one IP address",
                selected.key
            ),
        ));
    }

    let socket_port = request_port.unwrap_or(0);
    let addrs = raw_addrs
        .iter()
        .map(|raw_ip| {
            raw_ip
                .parse::<IpAddr>()
                .map(|ip| SocketAddr::new(ip, socket_port))
                .map_err(|e| {
                    Error::new(
                        Status::InvalidArg,
                        format!(
                            "invalid IP address '{raw_ip}' in resolve entry '{}': {e}",
                            selected.key
                        ),
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Some(ResolveOverride {
        host: request_host.to_string(),
        addrs,
    }))
}

fn build_client(key: &ClientKey, resolve: Option<&ResolveOverride>) -> Result<Client> {
    let platform = key.platform.as_deref().map(parse_platform).transpose()?;
    let mut emulation = resolve_emulation(&key.impersonate, platform)?;

    // Mutate the preset's own `tls_options` in place rather than calling
    // `ClientBuilder::tls_options()` afterwards: that setter replaces the
    // complete preset TLS config, whereas these are deliberately partial
    // overrides.
    if let Some(overrides) = &key.tls_options {
        let mut tls_options = emulation.tls_options.take().unwrap_or_default();
        if let Some(v) = &overrides.cipher_list {
            tls_options.cipher_list = Some(v.clone().into());
        }
        if let Some(v) = &overrides.curves_list {
            tls_options.curves_list = Some(v.clone().into());
        }
        if let Some(v) = &overrides.sigalgs_list {
            tls_options.sigalgs_list = Some(v.clone().into());
        }
        if let Some(v) = overrides.permute_extensions {
            tls_options.permute_extensions = Some(v);
        }
        if let Some(v) = overrides.session_ticket {
            tls_options.session_ticket = v;
        }
        emulation.tls_options = Some(tls_options);
    }

    let mut builder = Client::builder()
        .emulation(emulation)
        .redirect(wreq::redirect::Policy::default());

    if let Some(session) = &key.session {
        builder = builder.cookie_provider(session_jar(session)?);
    }

    if let Some(resolve) = resolve {
        builder = builder.resolve_to_addrs(resolve.host.clone(), resolve.addrs.clone());
    }
    if let Some(version) = &key.tls_min_version {
        builder = builder.tls_min_version(parse_tls_version(version)?);
    }
    if let Some(version) = &key.tls_max_version {
        builder = builder.tls_max_version(parse_tls_version(version)?);
    }
    match key.http_version.as_deref() {
        Some("http1") => builder = builder.http1_only(),
        Some("http2") => builder = builder.http2_only(),
        Some(other) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("unsupported httpVersion '{other}', expected \"http1\" or \"http2\""),
            ));
        }
        None => {}
    }

    builder.build().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("failed to build client: {e}"),
        )
    })
}

/// Client caching is keyed by `ClientKey`: fingerprinting is a
/// per-connection/per-client property, not a per-request one. `random` /
/// `weighted_random` pick one profile per process the first time they're
/// requested, then keep reusing that client (and its connection pool) like a
/// real browser session would. A cookie jar (shared per session id — see
/// `session_jar`) is only attached when `session` is set, so anonymous calls
/// never accidentally share cookies with unrelated callers that happen to use
/// the same profile.
fn get_or_build_client(key: ClientKey) -> Result<Client> {
    // Keep the lock through construction. Client construction performs no
    // network I/O, and this stops two concurrent first calls with the same
    // key from racing to build two clients.
    let mut cache = lock_client_cache()?;
    if let Some(entry) = cache.get_mut(&key) {
        entry.last_used = Instant::now();
        return Ok(entry.client.clone());
    }

    let client = build_client(&key, None)?;

    if cache.len() >= MAX_CACHED_CLIENTS {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(
        key,
        CachedClient {
            client: client.clone(),
            last_used: Instant::now(),
        },
    );
    Ok(client)
}

#[napi(object)]
pub struct FetchOptions {
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    /// Request body. Accepts either a UTF-8 string or raw bytes
    /// (`Uint8Array`/`Buffer`). Higher-level shapes (`URLSearchParams`,
    /// `Blob`, `ArrayBuffer`, typed arrays) are normalized to one of these two
    /// by the JS wrapper before they reach here; `FormData`/multipart is not
    /// supported (it would diverge the fingerprint — see README).
    pub body: Option<Either<String, Uint8Array>>,
    /// Browser/client fingerprint to emulate. Accepts either a native
    /// wreq-util profile name ("chrome_147", "safari_26", "firefox_142"),
    /// a curl-impersonate preset name ("chrome116", "ff109", "safari15_5" —
    /// see `listImpersonatePresets()`), or "random" / "weighted_random".
    /// Defaults to "chrome_147".
    pub impersonate: Option<String>,
    /// Overrides the platform `impersonate` declares in headers/User-Agent:
    /// "windows", "macos", "linux", "android", or "ios". Defaults to
    /// whatever `impersonate` resolves to (a curl-impersonate preset's own
    /// platform, or "macos" for a bare wreq-util profile name). Unlike
    /// `tlsOptions`, this does **not** diverge the TLS fingerprint — it only
    /// changes declared-platform headers (`sec-ch-ua-platform`, User-Agent),
    /// which is exactly what you want when e.g. running in a Linux container
    /// and need the declared platform to match the host's real TCP/IP stack
    /// instead of clashing with it. No effect when `impersonate` is
    /// "random"/"weighted_random". Client-level — see `session`.
    pub platform: Option<String>,
    /// Proxy URL for this request, e.g. "http://user:pass@host:3128" or
    /// "socks5://host:1080". Applied per request; does not affect which
    /// client/connection-pool this call reuses.
    pub proxy: Option<String>,
    /// Pin the request hostname to one or more literal IP addresses while
    /// keeping the original hostname for TLS SNI, certificate validation, and
    /// the Host header. Keys are "host" or "host:port"; bracket IPv6 keys
    /// when adding a port. Only the URL's initial host is considered, and a
    /// port-specific entry takes precedence over a host-only entry. Redirects
    /// to another host are not pinned, even if that host is also in this map:
    /// SSRF-sensitive callers must use `redirect: "manual"`, validate each
    /// Location, and provide a new pin per hop. Ignored when `proxy` is set
    /// because the proxy performs resolution.
    /// Requests carrying this option use a one-off client rather than the
    /// process-wide client cache; with `session` set, the one-off client
    /// still shares that session's cookie jar.
    pub resolve: Option<HashMap<String, Either<String, Vec<String>>>>,
    /// WHATWG redirect handling: "follow" (the default), "manual" (return the
    /// 3xx response), or "error" (reject on a redirect). Per-request: calls on
    /// the same `session` share one client and cookie jar regardless of their
    /// redirect mode.
    pub redirect: Option<String>,
    /// Opaque session id. Calls sharing the same (`impersonate`, `platform`,
    /// `session`, `tlsMinVersion`, `tlsMaxVersion`, `httpVersion`) reuse one
    /// underlying client, and the persistent cookie jar is keyed by the
    /// session id alone — cookies carry across calls, fingerprint settings,
    /// and `resolve` one-off clients the way they would in a real browser
    /// tab. Omit for stateless, cookie-less calls (the default) — this avoids
    /// unrelated callers on the same profile ever sharing cookies by
    /// accident.
    pub session: Option<String>,
    /// Overall request timeout in milliseconds.
    pub timeout_ms: Option<u32>,
    /// Maximum buffered response body size in bytes. Defaults to 32 MiB.
    pub max_response_bytes: Option<u32>,
    /// Minimum TLS version to offer during the handshake: "1.0", "1.1",
    /// "1.2", or "1.3". Client-level — see `session`.
    pub tls_min_version: Option<String>,
    /// Maximum TLS version to offer during the handshake. Client-level —
    /// see `session`.
    pub tls_max_version: Option<String>,
    /// Force a specific HTTP version instead of negotiating via ALPN:
    /// "http1" or "http2". Client-level — see `session`.
    pub http_version: Option<String>,
    /// Raw ClientHello overrides layered on top of `impersonate`'s own TLS
    /// config. Unset fields keep the preset's values; set fields diverge the
    /// fingerprint from a "pure" `impersonate` profile by definition — only
    /// use this when you specifically need bytes the preset doesn't offer.
    /// Client-level — see `session`.
    pub tls_options: Option<TlsOptionsOverride>,
}

#[napi(object)]
pub struct TlsOptionsOverride {
    /// OpenSSL-format cipher list, e.g. the same string curl-impersonate's
    /// wrapper scripts pass to `--ciphers`.
    pub cipher_list: Option<String>,
    /// OpenSSL-format supported-curves list (curl's `--curves`).
    pub curves_list: Option<String>,
    /// OpenSSL-format signature-algorithms list.
    pub sigalgs_list: Option<String>,
    /// Randomize ClientHello extension order (curl's `--tls-permute-extensions`).
    pub permute_extensions: Option<bool>,
    /// Whether to offer TLS session tickets (RFC 5077).
    pub session_ticket: Option<bool>,
}

#[napi(object)]
pub struct ImpersonatePresetInfo {
    /// curl-impersonate preset name (e.g. "chrome116").
    pub name: String,
    /// Underlying wreq-util profile this preset resolves to (e.g. "chrome_116").
    pub profile: String,
    pub platform: String,
    /// Browser version curl-impersonate pinned this preset to.
    pub browser_version: String,
    /// `false` means curl-impersonate's pinned version predates wreq-util's
    /// oldest profile for that browser family, so `profile` is the closest
    /// available approximation rather than a byte-exact fingerprint match.
    pub exact: bool,
}

/// Lists every curl-impersonate (https://github.com/lwthiker/curl-impersonate)
/// preset name accepted by `impersonate`, and what it actually resolves to.
#[napi]
pub fn list_impersonate_presets() -> Vec<ImpersonatePresetInfo> {
    CURL_IMPERSONATE_PRESETS
        .iter()
        .map(|p| ImpersonatePresetInfo {
            name: p.name.to_string(),
            profile: profile_name(p.profile),
            platform: platform_name(p.platform),
            browser_version: p.browser_version.to_string(),
            exact: p.exact,
        })
        .collect()
}

/// Removes every cached client for a session, along with the session's shared
/// in-memory cookie jar. Existing in-flight requests continue with their
/// already-cloned client (and its reference to the old jar).
#[napi]
pub fn clear_session(session: String) -> Result<u32> {
    let removed = {
        let mut cache = lock_client_cache()?;
        let count_before = cache.len();
        cache.retain(|key, _| key.session.as_deref() != Some(session.as_str()));
        (count_before - cache.len()) as u32
    };
    lock_session_jars()?.remove(&session);
    Ok(removed)
}

/// Clears all cached clients. Intended for controlled shutdown or test/setup
/// boundaries; it also drops all in-memory session cookies.
#[napi]
pub fn clear_client_cache() -> Result<u32> {
    let count = {
        let mut cache = lock_client_cache()?;
        let count = cache.len() as u32;
        cache.clear();
        count
    };
    lock_session_jars()?.clear();
    Ok(count)
}

#[napi]
pub struct FetchHeaders {
    entries: Vec<(String, String)>,
}

#[napi]
impl FetchHeaders {
    #[napi]
    pub fn get(&self, name: String) -> Option<String> {
        let matching: Vec<&str> = self
            .entries
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(&name))
            .map(|(_, v)| v.as_str())
            .collect();
        if matching.is_empty() {
            None
        } else {
            Some(matching.join(", "))
        }
    }

    #[napi]
    pub fn has(&self, name: String) -> bool {
        self.entries
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(&name))
    }

    #[napi]
    pub fn entries(&self) -> Vec<Vec<String>> {
        self.entries
            .iter()
            .map(|(k, v)| vec![k.clone(), v.clone()])
            .collect()
    }

    #[napi]
    pub fn keys(&self) -> Vec<String> {
        self.entries.iter().map(|(k, _)| k.clone()).collect()
    }

    #[napi]
    pub fn values(&self) -> Vec<String> {
        self.entries.iter().map(|(_, v)| v.clone()).collect()
    }
}

#[napi]
pub struct FetchResponse {
    #[napi(readonly)]
    pub status: u16,
    #[napi(readonly)]
    pub status_text: String,
    #[napi(readonly)]
    pub ok: bool,
    #[napi(readonly)]
    pub url: String,
    #[napi(readonly)]
    pub redirected: bool,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[napi]
impl FetchResponse {
    #[napi(getter)]
    pub fn headers(&self) -> FetchHeaders {
        FetchHeaders {
            entries: self.headers.clone(),
        }
    }

    // Decoding to string/JSON deliberately lives in the JS wrapper (index.js),
    // which does it straight off this Buffer. Native `text`/`json` used to be
    // exported here too, but nothing called them: they cost an extra body copy
    // plus a Rust->V8 conversion of the decoded result, so keeping a second,
    // unused decode path was pure surface area.
    #[napi]
    pub async fn array_buffer(&self) -> Result<Buffer> {
        Ok(self.body.clone().into())
    }
}

#[napi]
pub async fn fetch(url: String, options: Option<FetchOptions>) -> Result<FetchResponse> {
    let options = options.unwrap_or(FetchOptions {
        method: None,
        headers: None,
        body: None,
        impersonate: None,
        platform: None,
        proxy: None,
        resolve: None,
        redirect: None,
        session: None,
        timeout_ms: None,
        max_response_bytes: None,
        tls_min_version: None,
        tls_max_version: None,
        http_version: None,
        tls_options: None,
    });

    let redirect_policy = parse_redirect_policy(options.redirect.as_deref())?;
    let client_key = ClientKey {
        impersonate: options
            .impersonate
            .clone()
            .unwrap_or_else(|| DEFAULT_IMPERSONATE.to_string()),
        platform: options.platform,
        session: options.session,
        tls_min_version: options.tls_min_version,
        tls_max_version: options.tls_max_version,
        http_version: options.http_version,
        tls_options: options.tls_options.map(|o| TlsOptionsKey {
            cipher_list: o.cipher_list,
            curves_list: o.curves_list,
            sigalgs_list: o.sigalgs_list,
            permute_extensions: o.permute_extensions,
            session_ticket: o.session_ticket,
        }),
    };

    // DNS pins are target-specific and normally ephemeral, so never put their
    // clients (and connections bound to those IPs) in the shared LRU. When a
    // proxy is configured the proxy resolves the origin hostname; in that case
    // resolve is deliberately ignored and the ordinary cached client is safe.
    let client = if options.proxy.is_none() {
        if let Some(resolve) = options.resolve.as_ref() {
            let selected = select_resolve_override(&url, resolve)?;
            build_client(&client_key, selected.as_ref())?
        } else {
            get_or_build_client(client_key)?
        }
    } else {
        get_or_build_client(client_key)?
    };

    let method = match options.method {
        Some(m) => Method::from_bytes(m.as_bytes())
            .map_err(|e| Error::new(Status::InvalidArg, format!("invalid method: {e}")))?,
        None => Method::GET,
    };

    let requested_url = url.clone();
    let mut builder = client.request(method, url);

    if let Some(policy) = redirect_policy {
        builder = builder.redirect(policy);
    }

    if let Some(headers) = options.headers {
        // N-API maps a JS object into HashMap, whose iteration order is
        // randomized. Sort before applying to make outgoing custom headers
        // deterministic, and reject case-only duplicates that would otherwise
        // become repeated HTTP headers in wreq.
        let mut headers: Vec<_> = headers.into_iter().collect();
        headers.sort_unstable_by(|(left, _), (right, _)| {
            left.to_ascii_lowercase()
                .cmp(&right.to_ascii_lowercase())
                .then_with(|| left.cmp(right))
        });
        let mut seen = HashSet::with_capacity(headers.len());
        for (key, value) in headers {
            if !seen.insert(key.to_ascii_lowercase()) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("duplicate header name (case-insensitive): '{key}'"),
                ));
            }
            builder = builder.header(key, value);
        }
    }

    if let Some(body) = options.body {
        builder = match body {
            Either::A(text) => builder.body(text),
            Either::B(bytes) => builder.body(bytes.to_vec()),
        };
    }

    if let Some(proxy_url) = options.proxy {
        let proxy = Proxy::all(proxy_url.clone()).map_err(|e| {
            Error::new(
                Status::InvalidArg,
                format!("invalid proxy '{proxy_url}': {e}"),
            )
        })?;
        builder = builder.proxy(proxy);
    }

    if let Some(timeout_ms) = options.timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms as u64));
    }

    let response = builder
        .send()
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("request failed: {e}")))?;

    let status = response.status();
    let final_url = response.uri().to_string();
    // `response.uri()` is a parsed `http::Uri`, which normalizes an empty
    // path to "/" when displayed. Parse `requested_url` the same way before
    // comparing, otherwise a bare "https://example.com" (no redirect) would
    // misreport `redirected: true` against the normalized "https://example.com/".
    let redirected = requested_url
        .parse::<Uri>()
        .map(|uri| uri.to_string() != final_url)
        .unwrap_or_else(|_| requested_url != final_url);
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                v.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();

    let max_response_bytes = options
        .max_response_bytes
        .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES) as usize;
    // Pre-size the buffer so a large body doesn't repeatedly realloc+memcpy as
    // it streams in. Content-Length is attacker-controlled, though, so it is a
    // hint and never a promise: a hostile server advertising 10 GB must not be
    // able to make us allocate 10 GB up front. Clamp to what we would actually
    // accept anyway, and to a ceiling that keeps a lying header cheap -- honest
    // bodies past the ceiling just grow the Vec as before. `content_length()`
    // is None for chunked and for decompressed (gzip/br) bodies, which simply
    // falls back to starting empty.
    const PREALLOC_CEILING: u64 = 1024 * 1024;
    let prealloc = response
        .content_length()
        .map(|cl| cl.min(max_response_bytes as u64).min(PREALLOC_CEILING) as usize)
        .unwrap_or(0);

    let mut stream = response.bytes_stream();
    let mut body = Vec::with_capacity(prealloc);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("failed to read response body: {e}"),
            )
        })?;
        let remaining = max_response_bytes.saturating_sub(body.len());
        if chunk.len() > remaining {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "response body exceeds maxResponseBytes limit of {max_response_bytes} bytes"
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }

    Ok(FetchResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        ok: status.is_success(),
        url: final_url,
        redirected,
        headers,
        body,
    })
}
