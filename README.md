# @trishchuk/fetch

A Fetch-API-**shaped** HTTP client for Node.js, implemented as a Rust native
addon (via [napi-rs](https://napi.rs) v3) on top of
[`wreq`](https://github.com/0x676e67/wreq) — a hard fork of `reqwest` running
on hyper + BoringSSL through the `btls` crate — and
[`wreq-util`](https://github.com/0x676e67/wreq-util), which ships browser TLS
and HTTP/2 fingerprint profiles.

The point of this library is **TLS/HTTP2 fingerprint impersonation**: making
outbound requests whose ClientHello (JA3/JA4) and HTTP/2 SETTINGS/priority
frames (Akamai hash) match a real browser, not just an HTTP client that
happens to have a `fetch()`-shaped API. If you don't need fingerprint control,
`undici`/native `fetch` will be faster to build and easier to deploy (no Rust
toolchain, no BoringSSL). Use this when the _shape of your TLS handshake_ is
part of what you're testing or evading detection on.

It follows the WHATWG `fetch(input, init)` shape: `input` can be a URL string,
a `URL`, or a `Request`-like object; request bodies accept `string`,
`Uint8Array`/`Buffer`, `ArrayBuffer`, typed arrays, `URLSearchParams`, and
`Blob`; request headers accept a `Headers` instance, an array of pairs, or a
plain object; and the response carries a WHATWG `Headers` plus
`text()`/`json()`/`arrayBuffer()`/`bytes()`/`blob()`. It is still **not** a
full drop-in replacement, though — bodies are buffered (no `ReadableStream` in
either direction), and `FormData`/multipart, streaming, and `AbortSignal`
aren't wired up yet. See [Known limitations](#known-limitations), and
[`docs/fetch-compatibility.md`](./docs/fetch-compatibility.md) for the precise
compatibility matrix and a migration guide from native `fetch`/`undici`.

## Install / build

Once published (see [Releasing](#releasing)), `npm install @trishchuk/fetch`
pulls a prebuilt `.node` binary for your platform via
`optionalDependencies` — no Rust toolchain needed. Until then, or if you're
working on this repo, build the native addon locally. You need:

- Node.js (tested on Node 24)
- [pnpm](https://pnpm.io) (`packageManager: pnpm@10.26.2` in `package.json`)
- A Rust toolchain (`cargo`, stable channel) — building compiles `wreq`
  against BoringSSL via the `btls` crate, which additionally needs `cmake`
  and a C/C++ compiler on your `PATH` (see the
  [`btls`/BoringSSL build requirements](https://github.com/rust-lang/rust-bindgen#requirements)
  if the build fails looking for `clang`/`libclang`).

```bash
pnpm install

# Release build (optimized, LTO, stripped — this is what `.node` should be
# in normal use; the compile is slow because of LTO + BoringSSL).
pnpm run build

# Debug build (fast iteration, unoptimized binary).
pnpm run build:debug

# Run the test suite (node:test). Most tests spin up a local HTTP server;
# a couple in test/curl-impersonate-presets.test.js hit the real
# https://tls.peet.ws/api/all fingerprint-echo service and need network
# access.
pnpm test

# Format (Prettier for JS/MD/YAML, `cargo fmt` for Rust) and lint (ESLint +
# `cargo clippy -D warnings`). CI runs the `:check`/non-writing form of both.
pnpm run format
pnpm run lint
```

Both build commands emit a platform-specific binary (e.g.
`fetch.darwin-arm64.node`) plus the generated loader `binding.js` /
`binding.d.ts`, which the hand-authored `index.js` wrapper loads at require
time. `napi.targets` in `package.json` lists the platforms this crate
is set up to cross-compile for; you still need the matching Rust target
installed to actually build one.

## Quick start

```js
const { fetch } = require('@trishchuk/fetch')

async function main() {
  const res = await fetch('https://example.com')

  console.log(res.status) // 200
  console.log(res.ok) // true (status in 200..299)
  console.log(res.headers.get('content-type'))
  console.log(await res.text())
}

main()
```

`fetch()` never rejects on a non-2xx HTTP response — that's a normal
`FetchResponse` with `ok: false`. It only rejects on things that prevent a
response from existing at all: a connection/timeout failure, an unknown
`impersonate` name, an invalid `proxy` URL, or a malformed option like a bad
`tlsMinVersion`. Check `res.ok` / `res.status` for HTTP-level errors; use
`try/catch` for transport-level ones.

```js
const res = await fetch('https://example.com/api')
if (!res.ok) {
  throw new Error(`request failed: ${res.status} ${res.statusText}`)
}
const data = await res.json()
```

## Use cases

### 1. Basic impersonated GET/POST

Every call already impersonates a browser — `chrome_147` is the default when
`impersonate` is omitted.

```js
const { fetch } = require('@trishchuk/fetch')

// GET, default profile (chrome_147)
const res = await fetch('https://example.com')

// POST with a JSON body — body is a plain string, so stringify yourself
const created = await fetch('https://example.com/api/items', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'widget' }),
  impersonate: 'safari_26',
})
console.log(created.status, await created.json())
```

The call follows the WHATWG `fetch(input, init)` shape, so the inputs and body
types you'd reach for with native `fetch` mostly just work:

```js
// A URL object or a Request-like input, not just a string
await fetch(new URL('https://example.com/page'))
await fetch(new Request('https://example.com/api', { method: 'POST', body: 'hi' }))

// Form-encoded body (Content-Type is set for you)
await fetch('https://example.com/login', {
  method: 'POST',
  body: new URLSearchParams({ user: 'a', pass: 'b' }),
})

// Binary body (Uint8Array / Buffer / ArrayBuffer / typed arrays / Blob)
await fetch('https://example.com/upload', {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream' },
  body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
})

// Headers as a Headers instance or an array of pairs, and richer response reads
const res = await fetch('https://example.com/data', {
  headers: new Headers({ accept: 'application/json' }),
})
res.headers.get('content-type') // WHATWG Headers (iterable, forEach, get)
const bytes = await res.bytes() // Uint8Array; also blob(), arrayBuffer(), text(), json()
```

### 2. Picking a curl-impersonate preset and inspecting what it resolves to

`impersonate` also accepts any of the 19 preset names from
[curl-impersonate](https://github.com/lwthiker/curl-impersonate)'s
`browsers.json` (`chrome116`, `ff109`, `safari15_5`, ...) as a convenience for
callers migrating from curl-impersonate wrapper scripts. `listImpersonatePresets()`
tells you exactly which native `wreq-util` profile each one maps to, and
whether that mapping is byte-exact.

```js
const { fetch, listImpersonatePresets } = require('@trishchuk/fetch')

const presets = listImpersonatePresets()
const chrome116 = presets.find((p) => p.name === 'chrome116')
console.log(chrome116)
// {
//   name: 'chrome116',
//   profile: 'chrome_116',   // underlying wreq-util profile
//   platform: 'windows',
//   browserVersion: '116.0.5845.180',
//   exact: true,             // wreq-util ships this exact browser version
// }

const res = await fetch('https://example.com', { impersonate: 'chrome116' })
```

11 of the 19 presets are `exact: true` (wreq-util has a profile for that
precise browser version). The other 8 predate wreq-util's oldest profile per
browser family (Chrome/Edge/Firefox pre-2022) and resolve to the closest
newer profile available — a nearest-neighbor approximation, not a byte-exact
match. Check `exact` before relying on one of these for a fingerprint that
must match a specific old browser version.

### 3. Multi-request session with persistent cookies (login flow)

Pass the same `session` id on every call that should share a cookie jar —
exactly what a real browser tab does across page navigations. Keep the same
`impersonate`/TLS/HTTP options too if the calls should also share one client
and its connection pool.

```js
const { fetch } = require('@trishchuk/fetch')

const session = 'user-42' // any string you control; scope it per logical user/tab

const login = await fetch('https://example.com/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user: 'alice', pass: 'hunter2' }),
  session,
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)

// Same session id -> same cookie jar, so this call carries the Set-Cookie
// from /login. The jar is keyed by the session id alone; varying
// impersonate/TLS/HTTP options switches to a different cached client (new
// connection pool and fingerprint) but keeps the same cookies.
const profile = await fetch('https://example.com/account', { session })
console.log(await profile.json())
```

Calls that omit `session` entirely are stateless and never share cookies with
anyone, even other calls using the same `impersonate` profile — that's the
default specifically so unrelated callers can't accidentally leak cookies
into each other via a shared client.

### 4. Rotating proxy per request

`proxy` is applied per call, independent of client caching — it does not
change which cached client/session a call reuses, so you can rotate proxies
freely within one session without losing its cookie jar.

```js
const { fetch } = require('@trishchuk/fetch')

const proxies = [
  'http://user:pass@proxy1.example.com:3128',
  'http://user:pass@proxy2.example.com:3128',
  'socks5://proxy3.example.com:1080',
]

for (const [i, url] of ['https://a.example', 'https://b.example', 'https://c.example'].entries()) {
  const res = await fetch(url, { proxy: proxies[i % proxies.length] })
  console.log(url, res.status)
}
```

### 5. Timeout

```js
const { fetch } = require('@trishchuk/fetch')

try {
  const res = await fetch('https://example.com/slow', { timeoutMs: 5000 })
} catch (err) {
  console.error('request timed out or failed:', err.message)
}
```

### 6. Low-level TLS override escape hatch (`tlsOptions`)

`tlsOptions` lets you hand-tune specific ClientHello fields (cipher list,
curves, signature algorithms, extension permutation, session tickets) on top
of whatever `impersonate` resolves to. **This is not a free lunch: any field
you set diverges the fingerprint from the pure `impersonate` profile by
definition.** Unset fields keep the preset's values (confirmed empirically —
overriding only `cipherList` leaves curves, the HTTP/2 Akamai hash, and the
User-Agent exactly as the base profile's; only the cipher-related JA3/JA4
segments change), but every field you _do_ set is a byte your traffic no
longer shares with the real browser you're impersonating. Only reach for this
when you need bytes the preset doesn't offer.

```js
const { fetch } = require('@trishchuk/fetch')

const res = await fetch('https://example.com', {
  impersonate: 'chrome_147',
  tlsOptions: {
    cipherList: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256',
    permuteExtensions: true,
  },
})
```

`tlsOptions` (like `tlsMinVersion`/`tlsMaxVersion`/`httpVersion`) is part of
the client cache key — see [How it works](#how-it-works) — so a call with
`tlsOptions` set gets its own cached client, isolated from calls without it
even if `impersonate`/`session` otherwise match.

### 7. SSRF-safe DNS pinning and manual redirects

`resolve` closes the DNS-rebinding gap between an application's validation
lookup and the native socket connection. It changes only the connection IP;
TLS SNI, certificate validation, and the `Host` header continue to use the
URL's original hostname.

```js
const dns = require('node:dns').promises
const { fetch } = require('@trishchuk/fetch')

async function ssrfSafeFetch(input, maxRedirects = 10) {
  let url = new URL(input)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const dnsHost = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
    const { address } = await dns.lookup(dnsHost)
    assertPublicAddress(address) // your app-specific private/reserved-IP policy

    const response = await fetch(url, {
      resolve: { [url.host]: address },
      redirect: 'manual',
    })

    if (response.status < 300 || response.status > 399) return response
    const location = response.headers.get('location')
    if (location === null) return response
    if (hop === maxRedirects) throw new Error('too many redirects')
    url = new URL(location, url)
  }
}
```

The library intentionally does not decide whether an IP is safe. Validate
every address returned by DNS, including every address you pass for failover.
An initial request's `resolve` map is never installed for a redirect to another
host (same-host redirects keep using the initial host's pin), so SSRF-sensitive
code must use `redirect: "manual"` and repeat resolution, validation, and
pinning for each `Location`. `resolve` is ignored when `proxy` is set because
the proxy, not this client's direct connector, resolves the origin hostname.
If the flow needs cookies (a login that redirects, say), add a `session`: the
per-hop pinned clients all share that session's cookie jar, so cookies survive
the hops while every connection stays pinned.

## API reference

The public API is the ergonomic wrapper in `index.js` (typed by the
hand-authored `index.d.ts`), which wraps the NAPI-generated native binding
(`binding.js` / `binding.d.ts`, produced from `src/lib.rs`). Field names here
are the camelCase names you use from JS. For how this compares to native
`fetch` field by field — plus a migration guide — see
[`docs/fetch-compatibility.md`](./docs/fetch-compatibility.md).

### `fetch(input, init?) => Promise<FetchResponse>`

The main entry point, shaped like WHATWG `fetch`. `input` is a full URL
string, a `URL`, or a `Request`-like object (anything with a string `url`;
its `method`/`headers`/`body` are read and its body is buffered). `init` is
the option bag below — WHATWG fields (`method`, `headers`, `body`) plus this
package's fingerprint/transport options. When both `input` (a `Request`) and
`init` supply the same field, `init` wins. Every field is optional.

### `FetchInit`

| Field              | Type                                                                                | Default               | Meaning                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`           | `string`                                                                            | `"GET"`               | HTTP method.                                                                                                                                                                                                                                                 |
| `headers`          | `Headers \| [string,string][] \| Record<string,string>`                             | none                  | Request headers as a `Headers` instance, an array of pairs, or a plain object. Case-insensitive duplicate names are combined with `", "` the way `Headers` does.                                                                                             |
| `body`             | `string \| Uint8Array \| ArrayBuffer \| ArrayBufferView \| URLSearchParams \| Blob` | none                  | Request body. `URLSearchParams` and `Blob` also set a default `Content-Type` (form-urlencoded / the blob's `type`) unless you set one. **No `FormData`/multipart or streams** — see [Known limitations](#known-limitations).                                 |
| `impersonate`      | `string`                                                                            | `"chrome_147"`        | Fingerprint to emulate: a native `wreq-util` profile name (`"chrome_147"`, `"safari_26"`, `"firefox_142"`), a curl-impersonate preset name (`"chrome116"`, `"ff109"`, `"safari15_5"` — see `listImpersonatePresets()`), or `"random"` / `"weighted_random"`. |
| `platform`         | `string`                                                                            | profile default       | Declared OS for User-Agent/client-hint headers: `"windows"`, `"macos"`, `"linux"`, `"android"`, or `"ios"`. Client-level; has no effect for random profiles.                                                                                                 |
| `proxy`            | `string`                                                                            | none                  | Proxy URL for this request (`http://`, `https://`, or `socks5://`, with optional userinfo). Applied per request; does not affect client-cache reuse.                                                                                                         |
| `resolve`          | `Record<string, string \| string[]>`                                                | none                  | Pin the initial URL's `"host"` or `"host:port"` to literal IPs while preserving hostname-based TLS and `Host`. Port-specific entries win. Cross-host redirects are not pinned; ignored with `proxy`.                                                         |
| `redirect`         | `"follow" \| "manual" \| "error"`                                                   | `"follow"`            | WHATWG redirect policy. `"manual"` returns the 3xx response and readable `Location`; `"error"` rejects on a redirect. Per-request; also read from a `Request` input's own `redirect`.                                                                        |
| `session`          | `string`                                                                            | none (stateless)      | Opaque session id. Calls with the same (`session`, `impersonate`, `tlsMinVersion`, `tlsMaxVersion`, `httpVersion`) reuse one client; the cookie jar is keyed by `session` alone and shared across those settings and `resolve` one-offs. Omitted = no jar.   |
| `timeoutMs`        | `number`                                                                            | none (no timeout)     | Overall request timeout in milliseconds.                                                                                                                                                                                                                     |
| `maxResponseBytes` | `number`                                                                            | `33,554,432` (32 MiB) | Hard limit for the fully buffered response body. The request rejects if the decoded body exceeds it.                                                                                                                                                         |
| `tlsMinVersion`    | `string`                                                                            | profile default       | Minimum TLS version to offer: `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`. Client-level (part of the cache key).                                                                                                                                                      |
| `tlsMaxVersion`    | `string`                                                                            | profile default       | Maximum TLS version to offer. Client-level.                                                                                                                                                                                                                  |
| `httpVersion`      | `string`                                                                            | ALPN-negotiated       | Force `"http1"` or `"http2"` instead of letting ALPN pick. Client-level.                                                                                                                                                                                     |
| `tlsOptions`       | `TlsOptionsOverride`                                                                | none                  | Raw ClientHello overrides layered on the `impersonate` profile. **Diverges the fingerprint** — see [Use case 6](#6-low-level-tls-override-escape-hatch-tlsoptions). Client-level.                                                                            |

`impersonate`, `platform`, `session`, `tlsMinVersion`, `tlsMaxVersion`,
`httpVersion`, and `tlsOptions` are all **client-level**: they determine which cached
`wreq::Client` (and connection pool / cookie jar) a call uses. `method`,
`headers`, `body`, `proxy`, `redirect`, and `timeoutMs` are **per-request** and
don't affect caching — in particular, a session that logs in with
`redirect: "manual"` and then browses with the default `"follow"` keeps one
client and one cookie jar. A request carrying `resolve` uses a one-off client, even if its
map has no matching entry, so ephemeral IP pins never populate the shared LRU;
with `session` set the one-off client still shares the session's cookie jar.

### `FetchResponse`

| Member          | Type                    | Meaning                                                                                                                                                                         |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | `number` (readonly)     | HTTP status code.                                                                                                                                                               |
| `statusText`    | `string` (readonly)     | Canonical reason phrase for `status` from the `http` crate's table — not necessarily the literal wire reason phrase (HTTP/2 responses have none on the wire at all).            |
| `ok`            | `boolean` (readonly)    | `true` iff `status` is in `200..299`.                                                                                                                                           |
| `url`           | `string` (readonly)     | Final URL after following redirects.                                                                                                                                            |
| `redirected`    | `boolean` (readonly)    | `true` iff the final URL differs from the requested one.                                                                                                                        |
| `bodyUsed`      | `boolean` (readonly)    | `true` once any body accessor has run. Advisory — because the body is buffered, accessors are re-readable and don't throw on a second call (see below).                         |
| `headers`       | `Headers` (getter)      | Response headers as a WHATWG `Headers` (iterable, `forEach`, `getSetCookie`, case-insensitive `get`/`has`).                                                                     |
| `rawHeaders`    | `FetchHeaders` (getter) | The native header collection, preserving the server's **original casing and order** (which WHATWG `Headers` lower-cases and sorts away — kept for fingerprint work). See below. |
| `text()`        | `Promise<string>`       | Body decoded as UTF-8 (lossy, like WHATWG — invalid bytes become U+FFFD).                                                                                                       |
| `json()`        | `Promise<any>`          | Body parsed as JSON. Rejects on invalid JSON.                                                                                                                                   |
| `bytes()`       | `Promise<Uint8Array>`   | Raw body bytes as a `Uint8Array`.                                                                                                                                               |
| `blob()`        | `Promise<Blob>`         | Body as a `Blob`, typed from the response `Content-Type`.                                                                                                                       |
| `arrayBuffer()` | `Promise<ArrayBuffer>`  | Raw body bytes as a real Web `ArrayBuffer`.                                                                                                                                     |

All body accessors are **async** — the response body is fully read before
`fetch()` resolves, but the accessors return `Promise`s to keep the WHATWG
shape. Because the body is buffered in memory, accessors are **re-readable**:
calling `text()` then `json()` on the same response works (a real WHATWG
stream would throw on the second read). `bodyUsed` still flips to `true` after
the first read so code that checks it behaves sensibly.

### `clearSession(session) => number`

Drops every cached client for `session`, including its in-memory cookie jar.
Returns the number of cached client variants removed. Use this on logout or
when a session id is no longer valid. `clearClientCache()` clears every cached
client and is intended for controlled process/test boundaries.

### `FetchHeaders`

Not a plain `Record<string, string>` — a small case-insensitive header
collection, similar in spirit to the Fetch API's `Headers`:

| Method      | Returns                | Notes                                                                              |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `get(name)` | `string \| null`       | Case-insensitive. If multiple headers share a name, values are joined with `", "`. |
| `has(name)` | `boolean`              | Case-insensitive.                                                                  |
| `entries()` | `Array<Array<string>>` | All header pairs (`[name, value]`), original case, in response order.              |
| `keys()`    | `string[]`             | All header names, original case, may contain duplicates.                           |
| `values()`  | `string[]`             | All header values, in the same order as `keys()`.                                  |

### `listImpersonatePresets() => ImpersonatePresetInfo[]`

Lists all 19 curl-impersonate preset names accepted by `impersonate`.

### `ImpersonatePresetInfo`

| Field            | Type      | Meaning                                                                                                                                                                                              |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `string`  | curl-impersonate preset name, e.g. `"chrome116"`.                                                                                                                                                    |
| `profile`        | `string`  | The underlying `wreq-util` profile this preset resolves to, e.g. `"chrome_116"`.                                                                                                                     |
| `platform`       | `string`  | Platform the profile emulates, e.g. `"windows"`, `"macos"`, `"android"`.                                                                                                                             |
| `browserVersion` | `string`  | Browser version curl-impersonate pinned this preset to.                                                                                                                                              |
| `exact`          | `boolean` | `false` means curl-impersonate's pinned version predates `wreq-util`'s oldest profile for that browser family, so `profile` is a nearest-neighbor approximation, not a byte-exact fingerprint match. |

### `TlsOptionsOverride`

| Field               | Type      | Meaning                                                                                          |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `cipherList`        | `string`  | OpenSSL-format cipher list (same string curl-impersonate's wrapper scripts pass to `--ciphers`). |
| `curvesList`        | `string`  | OpenSSL-format supported-curves list (curl's `--curves`).                                        |
| `sigalgsList`       | `string`  | OpenSSL-format signature-algorithms list.                                                        |
| `permuteExtensions` | `boolean` | Randomize ClientHello extension order (curl's `--tls-permute-extensions`).                       |
| `sessionTicket`     | `boolean` | Whether to offer TLS session tickets (RFC 5077).                                                 |

Only these five fields are exposed — not the full ~25-field BoringSSL option
set (ECH GREASE, delegated credentials, PSK, key shares, etc. are
intentionally left out; they drift across `wreq` releases and are rarely
hand-tuned in practice).

## Known limitations

- **Buffered bodies only.** Both request and response bodies are fully
  materialized in memory. There is no `ReadableStream` support in either
  direction. Response bodies are capped at 32 MiB by default; use
  `maxResponseBytes` to select a different explicit bound. Large payloads
  (multi-GB downloads/uploads) are not a good fit.
- **No `FormData`/multipart request bodies.** Strings, `Uint8Array`/`Buffer`,
  `ArrayBuffer`, typed arrays, `URLSearchParams`, and `Blob` all work, but
  passing a `FormData` **throws**. A generic multipart serialization (its
  boundary token, part order, and header casing) is itself fingerprintable and
  would diverge from what the impersonated browser sends — the same reason
  `tlsOptions` is opt-in. Serialize multipart yourself and pass the bytes if
  you need it, or track this as a planned "match the browser's multipart"
  feature. Streaming upload (a `ReadableStream` body) is likewise unsupported.
- **No `AbortSignal` yet.** Passing `signal` has no effect; there's no
  in-flight cancellation. Real cancellation needs the abort wired down into the
  native request future (so the `wreq` request is actually dropped, not just
  the JS promise rejected) — planned, not yet done. Use `timeoutMs` for a hard
  deadline in the meantime.
- **`tlsOptions` genuinely diverges the fingerprint.** It composes with
  `impersonate` rather than clobbering it (unset fields keep the profile's
  values), but every field you _do_ set is, by construction, no longer what
  the impersonated browser would send. Don't reach for it unless you've
  confirmed you need it.
- **No cookie access outside sessions.** Cookies are only observable as a side
  effect of reusing a `session`; there's no API to read/set/clear individual
  cookies directly.
- **No per-request header repetition.** You can pass a `Headers`, an array of
  pairs, or an object, but case-insensitive duplicate names are **combined**
  with `", "` (WHATWG `Headers` semantics) before the request goes out — you
  can't send the same header name as two separate lines on the wire.
- **`statusText` honesty note.** It's the canonical reason phrase from the
  `http` crate's status table, not necessarily the literal bytes on the wire
  (HTTP/2 doesn't have a wire reason phrase at all). Low-stakes, but don't
  treat it as a raw passthrough.
- **TCP/IP-level fingerprint is NOT spoofed and reveals the real host OS.**
  Verified against `https://networktest.proxywing.com:8443/api/all`, which
  fingerprints the TCP handshake (TTL, window size, MSS, option order) the
  same way p0f does, independent of anything TLS-related: switching
  `impersonate` between `chrome_147`, `firefox_142`, and `safari_26` changed
  `ja4`/`user_agent` correctly on every call, but `tcpip.os_guess` stayed
  `"macOS / iOS"` and `tcpip.init_ttl`/`tcpip.tcp_options_order` stayed
  identical across all three — because those come from the host kernel's TCP
  stack, below anything a userspace TLS/HTTP library (this one included) can
  reach. A detector that cross-checks TLS fingerprint against TCP/IP
  fingerprint can catch a "Windows Chrome" TLS profile running over a
  macOS/Linux TCP stack as inconsistent.

  Fixing this requires the TCP/IP layer to actually match, which means
  running on a host whose _kernel_ is the OS you're declaring — not
  something a userspace library can do, and not as simple as "run it in a
  container" either. A container shares its host's kernel rather than
  bringing its own, so it can only make you look like whatever OS is
  actually running underneath. `docker/` in this repo has a
  Linux-coherent setup (Linux container + `platform: 'linux'`) plus
  `docker/verify-tcp-coherence.js` to check it against a live
  fingerprinting service — and that verification **caught a real gap**:
  on Docker Desktop for Mac, the container's egress traffic is NATed
  through the macOS host's own network stack, so `tcpip.os_guess` still
  said `"macOS / iOS"` from _inside_ a genuinely-Linux container (`uname
-a` correctly said Linux; the wire-level TCP fingerprint didn't care).
  This setup only buys real coherence on an actual Linux Docker host
  (bare metal or a cloud VM) — verify there before relying on it. For
  non-Linux targets (declaring Windows/macOS TCP/IP), the only remaining
  options are running on real hardware/VMs of that OS, or a privileged
  raw-socket packet rewriter that intercepts and edits outbound SYN
  packets — both outside this library's scope.

- This is a **from-scratch, purpose-built client**, not a general-purpose
  `fetch`/`undici` replacement. If you don't need TLS/HTTP2 fingerprint
  control, use something with a bigger surface area and less native-build
  overhead.

## How it works

The client is built on [`wreq`](https://github.com/0x676e67/wreq) (a
`reqwest` fork) running on `hyper` with BoringSSL as its TLS backend (via the
`btls` crate, rather than the usual `rustls`/OpenSSL choices) — BoringSSL is
what lets it produce the exact ClientHello byte layout real Chrome/Firefox/
Safari builds produce, because Chrome itself is built on BoringSSL.
[`wreq-util`](https://github.com/0x676e67/wreq-util) supplies ready-made
`Emulation` profiles (TLS options + HTTP/1/2 settings + default headers) per
browser/version/platform; `impersonate` selects one of those, or a
curl-impersonate preset name that's mapped onto the closest `wreq-util`
profile (see `CURL_IMPERSONATE_PRESETS` in `src/lib.rs`).

Every distinct combination of (`impersonate`, `session`,
`tlsMinVersion`, `tlsMaxVersion`, `httpVersion`, `tlsOptions`) gets its own cached
`wreq::Client`, keyed by a `ClientKey` (see `get_or_build_client` in
`src/lib.rs`). This isn't an optimization detail you can ignore — it's
load-bearing for correctness:

- **The TLS/HTTP2 fingerprint is a property of the client/connection, not of
  an individual request.** A `wreq::Client` is built once from an
  `Emulation` config and reuses that config (and its connection pool) for
  every request sent through it. There's no way to vary the fingerprint
  per-request on a shared client, so distinct fingerprints require distinct
  clients.
- **Cookies belong to the session, not to any single client.** A cookie jar
  is attached only when `session` is set, and it's keyed by the session id
  alone (`session_jar` in `src/lib.rs`): every client built for that session —
  cached clients for different `impersonate`/TLS settings and one-off
  `resolve` clients alike — shares the same jar, the way one browser tab
  keeps its cookies when its fingerprint settings change.
- `random`/`weighted_random` pick one profile the first time they're
  requested for a given cache key and then keep reusing that same client —
  matching how a real browser session sticks to one fingerprint rather than
  re-randomizing every request.
- Requests with a `resolve` map bypass this cache and build a one-off client.
  That prevents per-request pins from filling the LRU and ensures a connection
  pinned for one target can never be reused by an unpinned request. With
  `session` set, the one-off client still shares that session's cookie jar,
  so pinned and unpinned calls in one session see the same cookies.

`tlsOptions` overrides are applied by mutating the resolved `Emulation`'s own
`tls_options` struct field-by-field _before_ it's handed to the client
builder, rather than replacing the whole TLS config wholesale — that's what
lets an override of, say, only `cipherList` leave curves, HTTP/2 settings,
and headers untouched. This was verified empirically against
`https://tls.peet.ws/api/all`, not just assumed from reading the `wreq` API:
overriding only the cipher list left curves, the HTTP/2 Akamai hash, and the
`User-Agent` unchanged, with only the cipher-related JA3/JA4 segments
differing from the base profile's.

Other empirically confirmed facts (against `tls.peet.ws`, not mocked):

- Custom request headers do not corrupt the HTTP/2 fingerprint — the Akamai
  hash is identical with and without custom headers on the same profile.
- `chrome116` (curl-impersonate preset) produces `sec-ch-ua`, `User-Agent`,
  `Accept`, and `sec-fetch-*` headers matching curl-impersonate's actual
  `curl_chrome116` wrapper script nearly byte-for-byte.
- JA4's first segment (e.g. `t13d1516h2` vs `t13d1517h2`) can flip between a
  fresh TLS handshake and a session-resumed one on the _same_ client. This is
  expected BoringSSL/browser session-ticket behavior, not a bug — compare the
  cipher-suite/extension-hash segments of JA4 instead of the whole string if
  you're asserting fingerprint equality in tests (see
  `test/curl-impersonate-presets.test.js`).
- Cross-checked against a second, independent fingerprinting service —
  [ProxyWing's TLS Fingerprint Test](https://proxywing.com/tls-fingerprint)
  (backend at `https://networktest.proxywing.com:8443/api/all`) — not just
  `tls.peet.ws`: `chrome_147` produced the exact same JA4
  (`t13d1516h2_8daaf6152771_d8a2da3f94cd`) on both services. This endpoint
  also reports a passive TCP/IP fingerprint (p0f-style: TTL, window size,
  option order → OS guess), which is how the TCP/IP limitation above was
  found — see [Known limitations](#known-limitations).

## CI / Releasing

`.github/workflows/build.yml` is a reusable workflow that builds every
target in `napi.targets` (macOS arm64/x64, Linux x64/arm64-gnu, Windows x64)
and uploads each `.node` binary as a `bindings-<target>` artifact, running
`pnpm test` on every target except `aarch64-unknown-linux-gnu` (cross-compiled
on an x64 runner, not natively executable there — see the comment in
`build.yml`; run the suite on real arm64 Linux before trusting that binary).

- `ci.yml` calls it on every push/PR to `main`.
- `release.yml` calls it on `v*` tags, then assembles the binaries into
  `npm/<platform>/` (via `napi artifacts`), updates versions
  (`napi pre-publish`), and `npm publish`es each platform package plus the
  main `@trishchuk/fetch` package — the same `optionalDependencies` wiring
  `binding.js`'s binary-loading logic already expects.

To cut a release: bump `version` in `package.json`, commit, tag it
`v<version>` (matching exactly — the workflow checks this and fails
otherwise), and push the tag. Requires an `NPM_TOKEN` repository secret with
publish rights to `@trishchuk/fetch*`; `GITHUB_TOKEN` (automatic) is used for
the `napi pre-publish --gh-release` GitHub Release.

None of this has been run against a real GitHub Actions runner yet — the
workflows are `actionlint`-clean and `napi artifacts`'s artifact→npm-dir copy
step was verified locally with a real `.node` binary, but a live end-to-end
run (especially the Windows/BoringSSL and aarch64 cross-compile jobs, the
riskiest parts) still needs to happen on an actual push before trusting a
tagged release.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTORS.md](CONTRIBUTORS.md)
for who's already helped, and [CHANGELOG.md](CHANGELOG.md) for release
history.

## License

[MIT](LICENSE) © Taras Trishchuk
