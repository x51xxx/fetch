#![deny(clippy::all)]

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use async_compression::tokio::bufread::{DeflateDecoder, ZlibDecoder};
use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::AsyncRead;
use tokio_util::io::{ReaderStream, StreamReader};
use tokio_util::sync::CancellationToken;
use wreq::cookie::Jar;
use wreq::header::{CONTENT_ENCODING, CONTENT_LENGTH};
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
/// fingerprint settings and `resolve` pins, while two different `session` ids
/// still never see each other's cookies.
#[derive(Clone, PartialEq, Eq, Hash)]
struct ClientKey {
    impersonate: String,
    platform: Option<String>,
    session: Option<String>,
    tls_min_version: Option<String>,
    tls_max_version: Option<String>,
    http_version: Option<String>,
    tls_options: Option<TlsOptionsKey>,
    /// The `resolve` pin selected for this request, if any. Part of the key —
    /// and the *only* source `build_client` installs a DNS override from — so a
    /// pooled client can by construction never hold a connection for `host`
    /// to an address outside `addrs`: a different validated address set is a
    /// different key and therefore a different client and connection pool.
    pin: Option<ResolveOverride>,
}

/// A selected `resolve` pin in canonical form (see `ResolveOverride::new`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ResolveOverride {
    /// The request URL's host exactly as `http::Uri` parsed it (IPv6 brackets
    /// stripped), **not** case-folded. wreq looks the override up with an
    /// exact string match on the connecting URI's host, and `index.js` passes
    /// string URLs through unnormalised; folding case here would let
    /// `Example.test` and `example.test` share a client whose override matches
    /// only the first spelling, sending the second through system DNS — a
    /// silent pin bypass. Two spellings therefore cost two clients, never a
    /// weaker pin.
    host: String,
    /// Sorted and de-duplicated, so the same validated address set always
    /// maps to the same key regardless of the order the caller listed it in.
    /// The list is a set: connection-attempt order follows this sorted order,
    /// not the caller's.
    addrs: Vec<SocketAddr>,
}

impl ResolveOverride {
    fn new(host: String, mut addrs: Vec<SocketAddr>) -> Self {
        addrs.sort_unstable();
        addrs.dedup();
        Self { host, addrs }
    }
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

/// Clients whose key carries a `resolve` pin live in their own LRU.
static PINNED_CLIENTS: OnceLock<ClientCache> = OnceLock::new();

/// Bound the process-wide cache even when callers pass arbitrary session ids
/// or TLS overrides. Evicted clients are dropped; in-flight requests keep the
/// clone they already received.
const MAX_CACHED_CLIENTS: usize = 256;

/// Separate, smaller bound for pinned clients. The two populations have very
/// different cardinality: unpinned keys are one per fingerprint/session
/// configuration (a handful per process), while pinned keys are one per
/// host x validated-address-set, so an SSRF-pinning crawler touching thousands
/// of hosts produces thousands of keys. Sharing one LRU would let that churn
/// evict the few long-lived session clients — dropping their warm connections
/// and, for `random`/`weighted_random`, re-rolling the profile a session was
/// supposed to keep. 128 comfortably covers the hosts a crawler has in flight
/// at once, and anything colder than that has usually outlived wreq's ~90 s
/// idle-connection timeout anyway, so evicting it loses no live connection.
const MAX_CACHED_PINNED_CLIENTS: usize = 128;
const _: () = assert!(MAX_CACHED_PINNED_CLIENTS < MAX_CACHED_CLIENTS);

struct SessionJar {
    jar: Arc<Jar>,
    last_used: Instant,
}

type SessionJarMap = Mutex<HashMap<String, SessionJar>>;

static SESSION_JARS: OnceLock<SessionJarMap> = OnceLock::new();

/// Same scale as the client cache: live jars are the ones cached clients (or
/// in-flight requests) still reference, and those are bounded by
/// `MAX_CACHED_CLIENTS` + `MAX_CACHED_PINNED_CLIENTS` (the eviction below
/// never drops a referenced jar, so this is a soft bound).
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

fn lock_client_cache(
    cache: &'static OnceLock<ClientCache>,
) -> Result<MutexGuard<'static, HashMap<ClientKey, CachedClient>>> {
    cache
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| {
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
/// session — the cached per-`ClientKey` clients, pinned (`resolve`) ones
/// included — so cookies follow the session the way they follow a browser tab.
/// Lock order: this may be called while one of the client cache locks is held
/// (client cache → session jars); nothing locks in the other direction, and
/// the two client caches are never held at the same time.
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

    Ok(Some(ResolveOverride::new(request_host.to_string(), addrs)))
}

/// Builds the client for `key`. The DNS override (if any) comes from
/// `key.pin` and nowhere else, which is what keeps a cached pinned client's
/// connections inside the address set its key names.
fn build_client(key: &ClientKey) -> Result<Client> {
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
        // Take `Content-Encoding: deflate` away from wreq and decode it in
        // `deflate_body_stream` instead, which accepts both flavours of the
        // token the way browsers do. Load bearing rather than cosmetic: leaving
        // wreq's decoder on would decode the body twice.
        //
        // Fingerprint-neutral, but only because of wreq-util's
        // `emulation-compression` feature (see Cargo.toml): wreq's decompression
        // layer fills in `accept-encoding` solely when the header is *vacant*,
        // and with that feature on the emulation layer -- which sits outside it
        // -- has already written the profile's own value. So the wire header
        // stays whatever Chrome/Safari/Firefox sends, `deflate` included,
        // regardless of what this client decodes itself. Turn that feature off
        // and this line would silently stop advertising `deflate`.
        .no_deflate()
        .redirect(wreq::redirect::Policy::default());

    if let Some(session) = &key.session {
        builder = builder.cookie_provider(session_jar(session)?);
    }

    if let Some(pin) = &key.pin {
        builder = builder.resolve_to_addrs(pin.host.clone(), pin.addrs.clone());
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
        // A caller-supplied TLS override (`cipherList`/`curvesList`/
        // `sigalgsList`) that BoringSSL rejects surfaces here as a `Kind::Tls`
        // build error — that is bad input, not an internal failure, so report it
        // as `InvalidArg` (matching the other option-validation errors) and name
        // the culprit. Only do this when the caller actually passed overrides; a
        // `Kind::Tls` error without them would be an internal/system fault and
        // stays `GenericFailure`.
        if key.tls_options.is_some() && e.is_tls() {
            Error::new(Status::InvalidArg, format!("invalid tlsOptions: {e}"))
        } else {
            Error::new(
                Status::GenericFailure,
                format!("failed to build client: {e}"),
            )
        }
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
///
/// Keys carrying a `resolve` pin go to a separate, smaller LRU
/// (`PINNED_CLIENTS`, see `MAX_CACHED_PINNED_CLIENTS`) so high-cardinality
/// pinned traffic cannot evict the long-lived unpinned/session clients.
fn get_or_build_client(key: ClientKey) -> Result<Client> {
    let (cache, cap) = cache_for(&key);
    // Keep the lock through construction. Client construction performs no
    // network I/O, and this stops two concurrent first calls with the same
    // key from racing to build two clients.
    let mut cache = lock_client_cache(cache)?;
    if let Some(entry) = cache.get_mut(&key) {
        entry.last_used = Instant::now();
        return Ok(entry.client.clone());
    }

    let client = build_client(&key)?;

    evict_oldest_if_full(&mut cache, cap, |entry| entry.last_used);
    cache.insert(
        key,
        CachedClient {
            client: client.clone(),
            last_used: Instant::now(),
        },
    );
    Ok(client)
}

/// Which LRU (and its bound) a key belongs to.
fn cache_for(key: &ClientKey) -> (&'static OnceLock<ClientCache>, usize) {
    if key.pin.is_some() {
        (&PINNED_CLIENTS, MAX_CACHED_PINNED_CLIENTS)
    } else {
        (&CLIENTS, MAX_CACHED_CLIENTS)
    }
}

/// Makes room for one insert by dropping the least recently used entry once
/// `map` holds `cap` entries.
fn evict_oldest_if_full<K: Clone + Eq + std::hash::Hash, V>(
    map: &mut HashMap<K, V>,
    cap: usize,
    last_used: impl Fn(&V) -> Instant,
) {
    if map.len() < cap {
        return;
    }
    if let Some(oldest_key) = map
        .iter()
        .min_by_key(|(_, entry)| last_used(entry))
        .map(|(key, _)| key.clone())
    {
        map.remove(&oldest_key);
    }
}

#[napi(object)]
#[derive(Default)]
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
    /// Pinned requests reuse a pooled client (and its keep-alive
    /// connections) keyed by the client settings plus the URL host and the
    /// selected address set (order-insensitive, duplicates ignored); a
    /// different address set always gets a different client, so a pooled
    /// connection never goes to an address outside the pin it was opened
    /// for. Pinned clients live in their own LRU so they cannot evict
    /// unpinned/session clients. With `session` set, the pinned client
    /// shares that session's cookie jar.
    pub resolve: Option<HashMap<String, Either<String, Vec<String>>>>,
    /// WHATWG redirect handling: "follow" (the default), "manual" (return the
    /// 3xx response), or "error" (reject on a redirect). Per-request: calls on
    /// the same `session` share one client and cookie jar regardless of their
    /// redirect mode.
    pub redirect: Option<String>,
    /// Opaque session id. Calls sharing the same (`impersonate`, `platform`,
    /// `session`, `tlsMinVersion`, `tlsMaxVersion`, `httpVersion`,
    /// `tlsOptions`, selected `resolve` pin) reuse one underlying client, and
    /// the persistent cookie jar is keyed by the session id alone — cookies
    /// carry across calls, fingerprint settings, and `resolve` pins the way
    /// they would in a real browser tab. Omit for stateless, cookie-less
    /// calls (the default) — this avoids unrelated callers on the same
    /// profile ever sharing cookies by accident.
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
    // Both caches, one at a time: a pinned client left behind would keep the
    // session's old jar alive and fork its cookies from the fresh jar the next
    // unpinned call creates.
    let mut removed = 0u32;
    for cache in [&CLIENTS, &PINNED_CLIENTS] {
        let mut cache = lock_client_cache(cache)?;
        let count_before = cache.len();
        cache.retain(|key, _| key.session.as_deref() != Some(session.as_str()));
        removed += (count_before - cache.len()) as u32;
    }
    lock_session_jars()?.remove(&session);
    Ok(removed)
}

/// Clears all cached clients. Intended for controlled shutdown or test/setup
/// boundaries; it also drops all in-memory session cookies.
#[napi]
pub fn clear_client_cache() -> Result<u32> {
    let mut count = 0u32;
    for cache in [&CLIENTS, &PINNED_CLIENTS] {
        let mut cache = lock_client_cache(cache)?;
        count += cache.len() as u32;
        cache.clear();
    }
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

/// Classifies a transport-layer `wreq` failure into a stable, machine-readable
/// code. napi's `Error<Status>` can only carry one of napi's own fixed status
/// strings as the JS `error.code`, so the category is emitted as a `[CODE] `
/// prefix on the error message; the JS wrapper strips it and re-exposes it as
/// `FetchError.code`. Callers rotating proxies rely on this to tell a dead
/// proxy (`PROXY_CONNECT`) from a blocked or unreachable origin — a distinction
/// that is otherwise lost once every failure collapses to "request failed".
///
/// Order matters: the variants are checked most-specific first. `PROXY_CONNECT`
/// leads because localizing the fault to the proxy is the highest-value signal —
/// a proxy-connect failure that also carries a timeout is still reported as
/// `PROXY_CONNECT`, not `TIMEOUT`. `Connect` and `ProxyConnect` are disjoint
/// wreq `ErrorKind`s, so their order is only about intent, not correctness.
///
/// There is deliberately no `TLS` category. wreq's `is_tls()` matches only a
/// top-level `Kind::Tls`, which it produces for TLS *configuration* errors (a
/// bad `cipherList`/`curvesList`, cert parsing) — and those surface earlier, at
/// client-build time, never reaching this function. A request-time TLS handshake
/// or certificate failure is wrapped by the connector as `ErrorKind::Connect`,
/// so it is (correctly) reported as `CONNECT`; separating it would require
/// downcasting wreq's private BoringSSL backend, a coupling not worth the signal.
fn classify_request_error(e: &wreq::Error) -> &'static str {
    if e.is_proxy_connect() {
        "PROXY_CONNECT"
    } else if e.is_timeout() {
        "TIMEOUT"
    } else if e.is_connect() {
        "CONNECT"
    } else if e.is_connection_reset() {
        "CONNECTION_RESET"
    } else if e.is_redirect() {
        "REDIRECT"
    } else if e.is_decode() {
        "DECODE"
    } else if e.is_body() {
        "BODY"
    } else if e.is_request() {
        "REQUEST"
    } else {
        "REQUEST_FAILED"
    }
}

/// Builds the client and sends the request, stopping once response headers are
/// in. Returns the live `wreq::Response` (body **not** consumed) plus the
/// originally requested URL, which the caller needs to compute `redirected`.
///
/// Both `fetch` and `fetch_streaming` funnel through here, and that is load
/// bearing rather than mere tidiness: every fingerprint-relevant decision
/// (`ClientKey`, emulation profile, `tlsOptions`, header ordering, proxy,
/// `resolve`) is made in exactly one place. Duplicating this for the streaming
/// entry point would let a newly-added option reach one path and not the other,
/// and the streaming path would then silently emit a *different* TLS/HTTP2
/// fingerprint than the buffered one -- the single worst failure mode this
/// library can have, and one that a same-day regression test would not catch
/// because it compares only the options that exist today.
async fn send_request(url: String, options: FetchOptions) -> Result<(wreq::Response, String)> {
    let redirect_policy = parse_redirect_policy(options.redirect.as_deref())?;

    // When a proxy is configured the proxy resolves the origin hostname, so
    // `resolve` is deliberately ignored and the ordinary cached client is used.
    // Otherwise the selected pin becomes part of the client key: pinned
    // requests reuse a pooled client (and its warm TCP/TLS/HTTP-2 connections)
    // per host + validated address set. A `resolve` map with no entry for this
    // URL's host selects no pin and behaves exactly like an unpinned request.
    let pin = match (options.proxy.as_ref(), options.resolve.as_ref()) {
        (None, Some(resolve)) => select_resolve_override(&url, resolve)?,
        _ => None,
    };

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
        pin,
    };

    let client = get_or_build_client(client_key)?;

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

    let response = builder.send().await.map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("[{}] request failed: {e}", classify_request_error(&e)),
        )
    })?;

    Ok((response, requested_url))
}

/// A header value as WHATWG `Headers` and undici expose it: every byte becomes
/// the code point of the same number (isomorphic decode, i.e. latin1).
///
/// `HeaderValue::to_str()` refuses anything outside visible ASCII, and the old
/// `.unwrap_or_default()` turned such a value into an EMPTY string. Real servers
/// send raw UTF-8 there: tradeinn.com answers stale product URLs with
/// `Location: /bikeinn/ru/garmin-Велокомпьютер-…/p`, which came through as
/// `location: ""` — a redirect with no target. Decoding byte-for-byte loses
/// nothing: a caller that knows the bytes are UTF-8 recovers them with
/// `Buffer.from(value, 'latin1').toString('utf8')`.
fn isomorphic_decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Extracts the response metadata every entry point needs. Kept separate so the
/// buffered and streaming paths cannot disagree about `redirected` or header
/// casing/order.
fn response_meta(
    response: &wreq::Response,
    requested_url: &str,
) -> (u16, String, bool, String, bool, Vec<(String, String)>) {
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
        .map(|(k, v)| (k.as_str().to_string(), isomorphic_decode(v.as_bytes())))
        .collect();

    (
        status.as_u16(),
        status.canonical_reason().unwrap_or_default().to_string(),
        status.is_success(),
        final_url,
        redirected,
        headers,
    )
}

/// A body chunk can now fail two ways -- in the transport (wreq) or in our own
/// deflate decoder -- and the two carry different error classes, so the stream
/// item keeps them apart instead of flattening both into `io::Error`.
enum BodyError {
    Transport(wreq::Error),
    Decode(io::Error),
}

impl BodyError {
    fn into_napi(self) -> Error {
        match self {
            BodyError::Transport(e) => Error::new(
                Status::GenericFailure,
                format!(
                    "[{}] failed to read response body: {e}",
                    classify_request_error(&e)
                ),
            ),
            // Matches the class wreq's own decoder failures get
            // (`is_decode()` -> DECODE), so JS sees one error code for "the
            // body did not decode" no matter which decoder produced it.
            BodyError::Decode(e) => Error::new(
                Status::GenericFailure,
                format!("[DECODE] failed to read response body: error decoding response body: {e}"),
            ),
        }
    }
}

/// Reverses the `io::Error` boxing that `StreamReader` requires, so a transport
/// failure that happens to travel through the decoder keeps its original
/// classification instead of being reported as a decode error.
fn unwrap_body_error(e: io::Error) -> BodyError {
    if e.get_ref()
        .is_some_and(|inner| inner.downcast_ref::<wreq::Error>().is_some())
    {
        let kind = e.kind();
        return match e
            .into_inner()
            .and_then(|inner| inner.downcast::<wreq::Error>().ok())
        {
            Some(transport) => BodyError::Transport(*transport),
            // The check above already said this is a `wreq::Error`, so this arm
            // is dead -- but a panic here would abort the Node process, and the
            // kind alone is enough to keep the error honest.
            None => BodyError::Decode(kind.into()),
        };
    }
    BodyError::Decode(e)
}

/// Whether this response's body is a lone `deflate` payload that we decode
/// ourselves; if so, the headers that describe the *encoded* body are dropped.
///
/// wreq strips `Content-Encoding`/`Content-Length` whenever it decodes, and JS
/// must not be able to tell which decoder ran: leaving `content-encoding:
/// deflate` on an already-decoded body would make the deflate path the one
/// oddball among gzip/br/zstd.
///
/// Deliberately narrow. Only a single `deflate` token is claimed -- a list like
/// `gzip, deflate` is left to wreq (which fails it, exactly as before) rather
/// than guessed at, since decoding a chain in the wrong order is worse than not
/// decoding it.
fn take_deflate_decoding(response: &mut wreq::Response) -> bool {
    let mut values = response.headers().get_all(CONTENT_ENCODING).iter();
    let is_deflate = match (values.next(), values.next()) {
        (Some(value), None) => value
            .to_str()
            .is_ok_and(|value| value.trim().eq_ignore_ascii_case("deflate")),
        _ => false,
    };

    if is_deflate {
        let headers = response.headers_mut();
        headers.remove(CONTENT_ENCODING);
        headers.remove(CONTENT_LENGTH);
    }
    is_deflate
}

/// Cap on a single decoded chunk. Without it one `read()` of a 1000x-ratio body
/// could hand JS an unbounded buffer, and `maxResponseBytes` -- which is checked
/// per chunk -- would only notice after the allocation.
const DECODED_CHUNK_BYTES: usize = 64 * 1024;

/// The response body as chunks, decoding `deflate` ourselves when
/// `take_deflate_decoding` claimed it.
fn body_stream(response: wreq::Response, decode_deflate: bool) -> BoxBodyStream {
    if decode_deflate {
        deflate_body_stream(response.bytes_stream())
    } else {
        Box::pin(
            response
                .bytes_stream()
                .map(|r| r.map_err(BodyError::Transport)),
        )
    }
}

/// Decodes `Content-Encoding: deflate` accepting *both* readings of the token.
///
/// RFC 2616 defined `deflate` as a zlib-wrapped stream (RFC 1950), but a large
/// number of origins -- PHP/Apache with `zlib.output_compression` above all --
/// send a bare DEFLATE stream (RFC 1951) under the same name. Browsers accept
/// either, so an impersonating client has to match their *tolerance* and not
/// just their header string: a Chrome fingerprint that advertises `deflate` and
/// then fails on what Chrome renders fine is a fingerprint gap, not a strict
/// reading of the spec.
///
/// The two are told apart by the zlib header rather than by trying zlib and
/// retrying on error: sniffing needs 2 bytes and no rewind, which is what makes
/// this work on a streamed body. CMF/FLG is a valid zlib header when the
/// compression method is 8 and the 16-bit big-endian value is a multiple of 31.
/// A raw stream can in principle open with two bytes that satisfy that check
/// (it would have to start with a stored block whose length happens to line up);
/// browsers use the same heuristic and live with the same residue.
fn deflate_body_stream(
    raw: impl Stream<Item = wreq::Result<Bytes>> + Send + 'static,
) -> BoxBodyStream {
    Box::pin(
        futures_util::stream::once(async move {
            let mut raw = Box::pin(raw);
            let mut prefix = BytesMut::new();
            let mut pending_err = None;
            while prefix.len() < 2 {
                match raw.next().await {
                    Some(Ok(chunk)) => prefix.extend_from_slice(&chunk),
                    Some(Err(e)) => {
                        pending_err = Some(e);
                        break;
                    }
                    None => break,
                }
            }

            // An empty body (204/304/HEAD, or a `Content-Encoding` header on a
            // response that carries nothing) is not a truncated deflate stream.
            // Handing it to the decoder would turn a legal response into
            // "unexpected end of file".
            if prefix.is_empty() {
                let stream: BoxBodyStream = match pending_err {
                    Some(e) => Box::pin(futures_util::stream::once(async move {
                        Err(BodyError::Transport(e))
                    })),
                    None => Box::pin(futures_util::stream::empty()),
                };
                return stream;
            }

            let zlib_wrapped = prefix.len() >= 2
                && prefix[0] & 0x0f == 8
                && (u16::from(prefix[0]) << 8 | u16::from(prefix[1])) % 31 == 0;

            // `StreamReader` needs `io::Error`, so a transport failure is boxed
            // into one here and recovered by `unwrap_body_error` on the way out.
            let head = futures_util::stream::iter([Ok(prefix.freeze())]);
            let tail: Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>> = match pending_err {
                Some(e) => Box::pin(futures_util::stream::once(async move {
                    Err(io::Error::other(e))
                })),
                None => Box::pin(raw.map(|r| r.map_err(io::Error::other))),
            };
            let reader = StreamReader::new(head.chain(tail));

            let decoded: Pin<Box<dyn AsyncRead + Send>> = if zlib_wrapped {
                Box::pin(ZlibDecoder::new(reader))
            } else {
                Box::pin(DeflateDecoder::new(reader))
            };
            Box::pin(
                ReaderStream::with_capacity(decoded, DECODED_CHUNK_BYTES)
                    .map(|r| r.map_err(unwrap_body_error)),
            )
        })
        .flatten(),
    )
}

/// Marker for a transfer torn down via `AbortHandle.abort()` (the native half
/// of `AbortSignal`). Deliberately NOT part of the public error-code set
/// (`NATIVE_ERROR_CODES` / `FetchErrorCode`): the JS wrapper intercepts the
/// tag and rethrows the signal's own `reason` in its place, preserving reason
/// identity as WHATWG requires, so user code never observes this string.
fn aborted_error() -> Error {
    Error::new(
        Status::GenericFailure,
        "[ABORTED] request aborted".to_string(),
    )
}

/// Native half of the `AbortSignal` bridge. JS constructs one per
/// signal-carrying request, passes it as the trailing argument to
/// `fetch`/`fetchStreaming`, and calls `abort()` from the signal's `abort`
/// event. The flow is strictly one-way — JS fires the token, Rust observes it
/// at its await points — so no ThreadsafeFunction (and none of its lifecycle
/// or shutdown hazards) is involved.
///
/// This is a separate trailing argument rather than a `FetchOptions` field on
/// purpose: `FetchOptions` is a plain data bag that crosses into a `'static`
/// future, while this is a live object whose token must be cloned out on the
/// JS thread before the future is spawned.
#[napi]
#[derive(Default)]
pub struct AbortHandle {
    token: CancellationToken,
}

#[napi]
impl AbortHandle {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fires the token. Idempotent and thread-safe; calling it after the
    /// request already finished is a harmless no-op (a fired token nobody is
    /// watching does nothing).
    #[napi]
    pub fn abort(&self) {
        self.token.cancel();
    }
}

/// Pulls the next body chunk, letting a fired abort token win the race. The
/// `biased` ordering makes an already-fired token deterministic: if the caller
/// aborted, the abort is reported even when a chunk is also ready.
async fn next_chunk_or_abort(
    stream: &mut BoxBodyStream,
    abort: Option<&CancellationToken>,
) -> Result<Option<std::result::Result<Bytes, BodyError>>> {
    match abort {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => Err(aborted_error()),
            item = stream.next() => Ok(item),
        },
        None => Ok(stream.next().await),
    }
}

#[napi]
pub fn fetch<'env>(
    env: &'env Env,
    url: String,
    options: Option<FetchOptions>,
    abort: Option<&AbortHandle>,
) -> Result<PromiseRaw<'env, FetchResponse>> {
    // Clone the token out of the JS-owned handle before spawning: the handle
    // itself cannot cross into a `'static + Send` future, the token (an Arc
    // internally) can.
    let abort = abort.map(|handle| handle.token.clone());
    env.spawn_future(fetch_impl(url, options, abort))
}

async fn fetch_impl(
    url: String,
    options: Option<FetchOptions>,
    abort: Option<CancellationToken>,
) -> Result<FetchResponse> {
    let options = options.unwrap_or_default();
    // Read before `options` is moved into `send_request`.
    let max_response_bytes = options
        .max_response_bytes
        .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES) as usize;

    // The select! covers the whole pre-body phase — DNS, connect, proxy, TLS,
    // redirects, response headers — because dropping the `send_request` future
    // is how hyper tears the in-flight request down.
    let (mut response, requested_url) = match abort.as_ref() {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => return Err(aborted_error()),
            res = send_request(url, options) => res?,
        },
        None => send_request(url, options).await?,
    };
    let decode_deflate = take_deflate_decoding(&mut response);
    let (status, status_text, ok, final_url, redirected, headers) =
        response_meta(&response, &requested_url);

    // Pre-size the buffer so a large body doesn't repeatedly realloc+memcpy as
    // it streams in. Content-Length is attacker-controlled, though, so it is a
    // hint and never a promise: a hostile server advertising 10 GB must not be
    // able to make us allocate 10 GB up front. Clamp to what we would actually
    // accept anyway, and to a ceiling that keeps a lying header cheap -- honest
    // bodies past the ceiling just grow the Vec as before. `content_length()`
    // is None for chunked and for bodies wreq decompressed (gzip/br/zstd), and
    // for the deflate bodies decoded here it is the *encoded* length -- a lower
    // bound on what we will end up holding, which is still a fine hint. Both
    // cases just fall back to growing the Vec.
    const PREALLOC_CEILING: u64 = 1024 * 1024;
    let prealloc = response
        .content_length()
        .map(|cl| cl.min(max_response_bytes as u64).min(PREALLOC_CEILING) as usize)
        .unwrap_or(0);

    let mut stream = body_stream(response, decode_deflate);
    let mut body = Vec::with_capacity(prealloc);
    // The abort token stays in the race here too: without it, an abort landing
    // after headers would silently wait for the origin's next chunk (or the
    // timeout) before taking effect.
    while let Some(chunk) = next_chunk_or_abort(&mut stream, abort.as_ref()).await? {
        let chunk = chunk.map_err(BodyError::into_napi)?;
        let remaining = max_response_bytes.saturating_sub(body.len());
        if chunk.len() > remaining {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "[RESPONSE_TOO_LARGE] response body exceeds maxResponseBytes limit of {max_response_bytes} bytes"
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }

    Ok(FetchResponse {
        status,
        status_text,
        ok,
        url: final_url,
        redirected,
        headers,
        body,
    })
}

type BoxBodyStream = Pin<Box<dyn Stream<Item = std::result::Result<Bytes, BodyError>> + Send>>;

/// A response body that has **not** been read into memory. Chunks are pulled one
/// at a time, so peak RSS tracks the chunk size (tens of KiB) rather than the
/// response size.
///
/// Single-reader by contract: WHATWG locks a `ReadableStream` to one reader and
/// the JS wrapper preserves that, so `read()` is never called concurrently. The
/// mutex serializes anyway as a safety property rather than as a supported mode.
#[napi]
pub struct FetchBody {
    stream: Arc<tokio::sync::Mutex<Option<BoxBodyStream>>>,
    cancel: CancellationToken,
    /// Request-level abort (the caller's `AbortSignal`), kept apart from
    /// `cancel` because the two have opposite observable outcomes: an abort
    /// makes `read()` fail with `[ABORTED]` (WHATWG: an aborted response body
    /// errors), while a consumer cancel (`reader.cancel()`, `response.cancel()`)
    /// remains a clean EOF. Folding them into one token would turn every
    /// ordinary cancel into an AbortError.
    abort: CancellationToken,
    read_so_far: Arc<AtomicU64>,
    max_bytes: Option<u64>,
}

#[napi]
impl FetchBody {
    /// Resolves the next chunk, or `null` at end of stream. After `null` (or an
    /// error, or `cancel()`) the underlying stream is dropped and every
    /// subsequent call resolves `null`.
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        let mut guard = self.stream.lock().await;
        // A fired abort outranks everything, including "already finished":
        // WHATWG requires an aborted body to error, never to end cleanly, so
        // read-after-abort must not fall through to the EOF path below.
        if self.abort.is_cancelled() {
            *guard = None;
            return Err(aborted_error());
        }
        let Some(stream) = guard.as_mut() else {
            return Ok(None);
        };

        // `select!` rather than checking a flag between chunks: an abort or
        // cancel that arrives while we are parked waiting on the network must
        // take effect immediately, otherwise it would block until the origin
        // decides to send more data (or the connection times out). `biased`
        // keeps the priority deterministic: abort beats cancel beats data.
        let next = tokio::select! {
            biased;
            _ = self.abort.cancelled() => {
                *guard = None;
                return Err(aborted_error());
            }
            _ = self.cancel.cancelled() => {
                *guard = None;
                return Ok(None);
            }
            item = stream.next() => item,
        };

        match next {
            None => {
                // Drop at EOF so the connection returns to the pool promptly
                // instead of waiting for the JS object to be collected.
                *guard = None;
                Ok(None)
            }
            Some(Err(e)) => {
                *guard = None;
                Err(e.into_napi())
            }
            Some(Ok(chunk)) => {
                if let Some(max) = self.max_bytes {
                    let total = self
                        .read_so_far
                        .fetch_add(chunk.len() as u64, Ordering::Relaxed)
                        + chunk.len() as u64;
                    if total > max {
                        *guard = None;
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "[RESPONSE_TOO_LARGE] response body exceeds maxResponseBytes limit of {max} bytes"
                            ),
                        ));
                    }
                }
                // One copy per chunk. `Buffer::from_external` over the `Bytes`
                // would avoid it, but a Node Buffer is writable while `Bytes` may
                // share immutable storage with other owners (hyper hands out
                // slices of a shared read buffer), so handing JS a mutable view
                // is only sound once unique ownership is proven via
                // `Bytes::try_into_mut()`. Deferred until measurement shows the
                // copy actually matters: chunks are tens of KiB, which is noise
                // next to the network and disk syscalls around them.
                Ok(Some(chunk.to_vec().into()))
            }
        }
    }

    /// Aborts the transfer and releases the connection. Idempotent, and safe to
    /// call while a `read()` is in flight.
    #[napi]
    pub fn cancel(&self) {
        self.cancel.cancel();
        // Signalling the token is only half of it. The token is observed inside
        // `read()`, so if no read is in flight -- and none ever comes, which is
        // exactly the `await res.cancel()` straight after `fetch()` case -- the
        // boxed stream and its connection would sit alive until the JS object is
        // finalized. Drop it here instead.
        //
        // `try_lock` rather than blocking: a held lock means a `read()` IS in
        // flight, and that path already drops the stream when the token fires.
        // Dropping is all this does -- never spawn from here, since a Drop that
        // touches the runtime would panic outside a runtime context.
        if let Ok(mut guard) = self.stream.try_lock() {
            *guard = None;
        }
    }
}

/// Headers-first response whose body is still on the wire.
#[napi]
pub struct StreamingFetchResponse {
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
    body: Mutex<Option<FetchBody>>,
}

#[napi]
impl StreamingFetchResponse {
    #[napi(getter)]
    pub fn headers(&self) -> FetchHeaders {
        FetchHeaders {
            entries: self.headers.clone(),
        }
    }

    /// Hands the body out exactly once; a second call returns `null`. That single
    /// ownership transfer is what makes `bodyUsed` meaningful on this path.
    #[napi]
    pub fn take_body(&self) -> Option<FetchBody> {
        self.body.lock().ok().and_then(|mut b| b.take())
    }
}

/// Like `fetch`, but resolves as soon as response headers are in, leaving the
/// body to be pulled incrementally.
///
/// The split matters for error timing: `fetch` cannot resolve until the body has
/// been read, so a mid-body failure rejects the `fetch` promise. Here the promise
/// is already resolved, so the same failure surfaces from `FetchBody::read`
/// instead. That difference is why streaming is opt-in rather than the default.
#[napi]
pub fn fetch_streaming<'env>(
    env: &'env Env,
    url: String,
    options: Option<FetchOptions>,
    abort: Option<&AbortHandle>,
) -> Result<PromiseRaw<'env, StreamingFetchResponse>> {
    // Same shape as `fetch`: clone the token on the JS thread, spawn a
    // `'static` future.
    let abort = abort.map(|handle| handle.token.clone());
    env.spawn_future(fetch_streaming_impl(url, options, abort))
}

async fn fetch_streaming_impl(
    url: String,
    options: Option<FetchOptions>,
    abort: Option<CancellationToken>,
) -> Result<StreamingFetchResponse> {
    let options = options.unwrap_or_default();
    // `None` means "omitted", which on this path means no cap -- streaming
    // exists precisely so a body need not fit in memory. An explicit value is
    // honoured verbatim, *including* 0: `maxResponseBytes: 0` must reject the
    // first non-empty chunk here exactly as it does on the buffered path, so it
    // cannot be folded into "unlimited".
    let max_bytes = options.max_response_bytes.map(u64::from);

    let (mut response, requested_url) = match abort.as_ref() {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => return Err(aborted_error()),
            res = send_request(url, options) => res?,
        },
        None => send_request(url, options).await?,
    };
    let decode_deflate = take_deflate_decoding(&mut response);
    let (status, status_text, ok, final_url, redirected, headers) =
        response_meta(&response, &requested_url);

    Ok(StreamingFetchResponse {
        status,
        status_text,
        ok,
        url: final_url,
        redirected,
        headers,
        body: Mutex::new(Some(FetchBody {
            stream: Arc::new(tokio::sync::Mutex::new(Some(body_stream(
                response,
                decode_deflate,
            )))),
            cancel: CancellationToken::new(),
            // The same token `fetch()`'s select observed pre-headers: once the
            // body is handed over, an abort surfaces from `read()` instead.
            abort: abort.unwrap_or_default(),
            read_so_far: Arc::new(AtomicU64::new(0)),
            max_bytes,
        })),
    })
}

#[cfg(test)]
mod tests {
    //! Pure-logic tests only. Anything returning `napi::Result` drags
    //! `napi::Error`'s `Drop` (a `napi_delete_reference` call) into the test
    //! binary, which cannot link outside a Node process -- so pin selection
    //! end to end, cache routing under churn and `clearSession` are covered by
    //! `test/pinned-pool.test.js` against the real addon instead.
    use super::*;

    fn addrs(raw: &[&str]) -> Vec<SocketAddr> {
        raw.iter().map(|a| a.parse().unwrap()).collect()
    }

    fn pin(host: &str, raw: &[&str]) -> ResolveOverride {
        ResolveOverride::new(host.to_string(), addrs(raw))
    }

    fn key(pin: Option<ResolveOverride>) -> ClientKey {
        ClientKey {
            impersonate: DEFAULT_IMPERSONATE.to_string(),
            platform: None,
            session: Some("s".to_string()),
            tls_min_version: None,
            tls_max_version: None,
            http_version: None,
            tls_options: None,
            pin,
        }
    }

    #[test]
    fn pin_key_ignores_address_order_and_duplicates() {
        let a = pin(
            "pin.test",
            &["10.0.0.2:443", "10.0.0.1:443", "10.0.0.2:443"],
        );
        let b = pin("pin.test", &["10.0.0.1:443", "10.0.0.2:443"]);
        assert_eq!(a, b);
        assert_eq!(a.addrs, addrs(&["10.0.0.1:443", "10.0.0.2:443"]));
        // Equal pins make equal client keys, so they land in one cache slot.
        let set: HashSet<ClientKey> = [key(Some(a)), key(Some(b))].into();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn pin_key_distinguishes_address_set_host_port_and_spelling() {
        let base = pin("pin.test", &["10.0.0.1:443"]);
        let others = [
            pin("pin.test", &["10.0.0.1:443", "10.0.0.2:443"]), // superset
            pin("pin.test", &["10.0.0.9:443"]),                 // other address
            pin("pin.test", &["[::1]:443"]),                    // other family
            pin("pin.test", &["10.0.0.1:8443"]),                // other port
            pin("other.test", &["10.0.0.1:443"]),               // other host
            // Not case-folded: wreq's override lookup is an exact string match
            // on the URI host, so two spellings must never share one client.
            pin("Pin.test", &["10.0.0.1:443"]),
        ];
        for other in &others {
            assert_ne!(&base, other);
            assert!(key(Some(base.clone())) != key(Some(other.clone())));
        }
        assert!(key(None) != key(Some(base)));
    }

    #[test]
    fn pinned_keys_route_to_their_own_smaller_lru() {
        let (unpinned_cache, unpinned_cap) = cache_for(&key(None));
        let (pinned_cache, pinned_cap) = cache_for(&key(Some(pin("pin.test", &["10.0.0.1:443"]))));
        assert!(std::ptr::eq(unpinned_cache, &CLIENTS));
        assert_eq!(unpinned_cap, MAX_CACHED_CLIENTS);
        assert!(std::ptr::eq(pinned_cache, &PINNED_CLIENTS));
        assert_eq!(pinned_cap, MAX_CACHED_PINNED_CLIENTS);
        assert!(!std::ptr::eq(unpinned_cache, pinned_cache));
    }

    #[test]
    fn eviction_drops_only_the_least_recently_used_entry_at_the_cap() {
        let t0 = Instant::now();
        let mut map: HashMap<u32, Instant> = (0..3u32)
            .map(|i| (i, t0 + Duration::from_secs(u64::from(i))))
            .collect();
        evict_oldest_if_full(&mut map, 4, |t| *t);
        assert_eq!(map.len(), 3, "below the cap nothing is evicted");
        evict_oldest_if_full(&mut map, 3, |t| *t);
        assert_eq!(map.len(), 2);
        assert!(!map.contains_key(&0), "the oldest entry goes first");
    }
}
