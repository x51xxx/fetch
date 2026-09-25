# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`resolve`-pinned requests now reuse a pooled client** instead of building
  a single-use client per request, so a caller that pins every request (e.g.
  for SSRF safety) keeps its keep-alive TCP/TLS/HTTP-2 connections instead of
  paying a fresh handshake each time. The selected pin — the URL host exactly as
  written plus the address set, sorted and de-duplicated (so connection
  attempts now follow sorted address order, not the order the caller listed
  the addresses in) — is part of the client cache key and is the only source
  of the client's DNS override, so a pooled connection can never reach an
  address outside the pin it was opened for; a
  different validated address set always gets a different client. The host is
  deliberately not case-folded (wreq matches overrides by the exact URI host),
  so two spellings cost two clients rather than weakening a pin. Pinned clients
  live in their own LRU bounded at 128, separate from the 256-entry cache of
  unpinned clients, so high-cardinality pinned traffic cannot evict long-lived
  session clients (or re-roll a `random` profile). A `resolve` map with no entry
  for the URL's host now uses the ordinary cached client, same as no `resolve`.
  Cookie semantics are unchanged: the jar still follows `session` alone, and
  `clearSession()` / `clearClientCache()` drop pinned clients too (counted in
  their return value), so a cached pinned client never keeps a cleared
  session's old cookie jar alive.

## [1.3.0] - 2026-08-05

### Added

- **`AbortSignal` support with full WHATWG semantics** (`init.signal`, also
  inherited from a `Request` input; an explicit `null` disables inheritance).
  The signal covers every phase of a request: pre-flight (an already-aborted
  signal rejects before any work), connect/proxy/TLS/redirects/headers (the
  native future is raced against a `tokio_util` `CancellationToken` and torn
  down by drop), each chunk of a buffered body, and each `read()` of a streamed
  one — an abort unparks a read that is waiting on the socket. The rejection
  value is the signal's own `reason`, identity-preserved as the spec requires:
  `controller.abort(customError)` comes back as that exact object, never
  wrapped in a `FetchError`; on a streamed response after headers, the body
  stream *errors* with that reason (WHATWG: never a clean close). Consumer
  cancellation (`reader.cancel()`, `response.cancel()`) remains a clean close —
  the native `FetchBody` keeps two separate tokens precisely so a cancel can
  never be mistaken for an abort. Compose sources with the standard
  `AbortSignal.any()` / `AbortSignal.timeout()` primitives; `timeoutMs` stays
  independent (`FetchError` `code: 'TIMEOUT'` vs the signal's `TimeoutError`
  `DOMException` — first to fire wins). Abort listeners are removed on every
  terminal path (settled fetch, EOF, body error, cancel, null-body response),
  so reusing one long-lived signal across many requests accumulates nothing; a
  streamed response abandoned unread is covered by a `WeakRef` +
  `FinalizationRegistry` safety net. Internally the bridge is one-way — JS
  fires the token via a new native `AbortHandle`, Rust only observes it — so no
  ThreadsafeFunction is involved.

## [1.2.1] - 2026-07-31

### Fixed

- **`Content-Encoding: deflate` now accepts raw DEFLATE (RFC 1951), not just
  zlib-wrapped (RFC 1950).** wreq (via tower-http) decodes `deflate` strictly as
  a zlib stream, so an origin that sends a bare DEFLATE stream under that token
  — the PHP/Apache `zlib.output_compression` behaviour, which is common enough
  that browsers all sniff for it — failed the whole request with
  `[DECODE] ... deflate decompression error` before a single byte reached the
  caller. `deflate` decoding moved out of wreq (`ClientBuilder::no_deflate()`)
  into `deflate_body_stream`, which picks the decoder from the first two bytes:
  zlib when CMF/FLG says method 8 and the 16-bit value is a multiple of 31, raw
  otherwise. Sniffing rather than try-zlib-then-retry is what keeps this working
  on a streamed body — there is no rewind. Both the buffered and `stream: true`
  paths go through it, `maxResponseBytes` still counts decoded bytes, and
  `Content-Encoding`/`Content-Length` are stripped exactly as wreq does for
  gzip/br/zstd, so nothing downstream can tell which decoder ran. Only a lone
  `deflate` token is claimed; a chain like `deflate, gzip` is left alone.

  This is a fingerprint fix as much as a compatibility one: Chrome advertises
  `deflate` *and* accepts either flavour, so impersonating Chrome means matching
  its tolerance, not just its header string.

### Changed

- **`Accept-Encoding` is now the impersonated browser's own header** rather than
  one synthesised from enabled Cargo features. wreq-util only emits a profile's
  `Accept-Encoding` under its `emulation-compression` feature, which was off, so
  every profile — Chrome, Firefox, Safari, okhttp alike — sent tower-http's
  fallback `gzip,deflate,br`: no spaces, no `zstd`, and appended last instead of
  sitting in the profile's own header order. Three separate tells for anything
  fingerprinting headers. Now `chrome_147` sends `gzip, deflate, br, zstd`,
  `chrome116` (curl-impersonate preset) sends `gzip, deflate, br`, and
  `okhttp_5` sends `gzip`, each in its profile's position.

  `zstd` decoding is enabled alongside it, since the modern profiles now
  advertise `zstd` and advertising an encoding you cannot decode is how you get
  a body that only fails in production. No new native dependency: zstd-sys was
  already built by wreq-util's default features.

## [1.2.0] - 2026-07-28

### Added

- **Streaming response bodies** via a new `stream: true` request option. The
  promise resolves as soon as response headers arrive and `response.body` is a
  WHATWG `ReadableStream<Uint8Array>`, so peak memory tracks the chunk size
  rather than the response size. Measured on a 2 GiB download: **~206 MiB peak
  RSS streamed vs ~4.1 GiB buffered**, roughly a 20x reduction, with the figure
  staying flat as the body grows (182/202/206 MiB at 256 MiB/1 GiB/2 GiB).
  Reproduce with `node bench/memory-large-file.mjs 256 1024 2048`. Those figures
  come from an Apple M3 Max (arm64, 16 cores, 48 GB, macOS 26.3, Node v24.18.0)
  over loopback; the buffered column moves 20–25% between runs with GC timing,
  so treat them as the shape of the difference rather than portable absolutes —
  the flat streaming column is the reproducible part. Before this,
  a body larger than `maxResponseBytes` (32 MiB by default) was not slow but
  outright impossible.

  Streaming is **opt-in and the default stays buffered**, because it changes
  error timing: a mid-body failure now rejects while reading the stream instead
  of rejecting `fetch()`. Making it the default would silently break existing
  `try { await fetch() } catch` callers.

  The streamed response is WHATWG-faithful where the buffered one deliberately
  is not: the body is genuinely one-shot (`bodyUsed` is real, a second accessor
  throws `TypeError`), null-body statuses and `HEAD` give `body === null`, and
  it also exposes `cancel()` and `Symbol.asyncDispose`. In a differential test
  against Node's built-in `fetch` (undici) the streaming path matches on 17 of
  18 scenarios versus 15 of 18 for the buffered path (`node
  test/undici-parity.mjs`); the one streaming gap is `clone()`, which throws by
  design (below).

  The TLS/HTTP2 fingerprint is unchanged by streaming — both entry points share
  one request-building path in Rust, and JA4, the Akamai HTTP/2 hash, and
  peetprint are byte-identical across the two modes when compared on fresh
  handshakes. (Compare fresh handshakes only: a resumed TLS session legitimately
  shifts JA4's first segment.)

  `maxResponseBytes` is mode-dependent and worth reading carefully: on the
  buffered path it keeps its 32 MiB default; with `stream: true` it is **unset
  by default** (unbounded is the point) but an explicit value still applies as a
  cumulative cap, and an explicit `0` rejects the first non-empty chunk rather
  than meaning "unlimited". The buffering accessors (`text()`, `json()`,
  `bytes()`, `arrayBuffer()`, `blob()`) always re-apply the 32 MiB limit even on
  a streamed response, since they materialize the body — otherwise `stream: true`
  followed by `.json()` would reintroduce the very exhaustion the cap prevents.

  Documented download idiom:

  ```js
  const res = await fetch(url, { stream: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path))
  ```

- `response.clone()` on a buffered response. The body is already buffered
  natively, so this copies no payload at all — only the wrapper — and each copy
  keeps its own `bodyUsed` and its own `Headers`. It deliberately does **not**
  throw when `bodyUsed` is true: on this path `bodyUsed` is advisory and the
  accessors are re-readable, so refusing to clone a response you can still
  re-read would be a stricter rule for the weaker operation.

  On a **streamed** response `clone()` throws `TypeError` by design. WHATWG
  defines it as `tee()`, and `tee()` buffers the slower branch without bound, so
  a caller who reads one branch and ignores the other would hold the whole body
  in memory — undoing the point of `stream: true`. It would also break
  backpressure and cannot split the single cumulative `maxResponseBytes`
  counter. The primitive remains available and self-documenting: call
  `response.body.tee()` directly to opt into that cost.

- Transport-level failures now reject with a `FetchError` carrying a stable,
  machine-readable `code` instead of a single opaque `"request failed"` string.
  Codes are `PROXY_CONNECT`, `TIMEOUT`, `CONNECT`, `CONNECTION_RESET`,
  `REDIRECT`, `DECODE`, `BODY`, `REQUEST`, `REQUEST_FAILED`, and
  `RESPONSE_TOO_LARGE`. This lets proxy-rotation logic distinguish a dead proxy
  (`PROXY_CONNECT`) from an unreachable origin (`CONNECT`) without parsing error
  text. The originating native error is preserved on `err.cause`, and
  `FetchError` is exported for `instanceof` checks. There is deliberately no
  `TLS` code: request-time TLS handshake and certificate failures are wrapped by
  the connector as a connect error and so surface as `CONNECT`, while invalid
  TLS *configuration* (a bad `cipherList`, etc.) fails earlier at client-build
  time. `TIMEOUT` is stage-agnostic and does not localize the fault to the proxy
  vs. the origin. Option-validation errors (bad `impersonate`, invalid `proxy`
  URL, malformed `tlsMinVersion`, invalid `tlsOptions`) continue to reject with
  the underlying `Error`/`TypeError`.

### Changed

- Invalid `tlsOptions` (a `cipherList`/`curvesList`/`sigalgsList` the TLS backend
  rejects) now fail with `code: 'InvalidArg'` and an `"invalid tlsOptions: …"`
  message, instead of the previous opaque `GenericFailure`
  `"failed to build client: …"`. This is caller input, so it is now reported like
  the other option-validation errors. Build failures unrelated to caller-supplied
  TLS overrides remain `GenericFailure`.
- Passing both `resolve` and `proxy` now emits a one-time `process` warning
  (`MYFETCH_RESOLVE_IGNORED`) instead of silently dropping the `resolve` pin.
  The behavior is unchanged — the proxy still resolves the origin hostname, so
  the pin has no effect — but the contradiction is no longer invisible at
  runtime. A hard error was deliberately rejected: a caller that always sets
  `resolve` and only sometimes sets `proxy` is a legitimate pattern that must
  not break. Restoring client-side resolution for SOCKS5 (`socks5` vs
  `socks5h`) is left as a follow-up pending verification of wreq's SOCKS + DNS
  override behavior.

## [1.1.0] - 2026-07-19

### Added

- `resolve` pins the initial request hostname to caller-selected literal IP
  addresses without changing TLS SNI, certificate validation, or the `Host`
  header. Pinned requests use one-off clients so ephemeral targets do not fill
  the shared client cache; with `session` set, those one-off clients share the
  session's cookie jar, so cookies survive per-hop pinned fetching.
- WHATWG-aligned `redirect: "follow" | "manual" | "error"` handling, applied
  per request (a `session` keeps one client and cookie jar across redirect
  modes) and also read from a `Request` input's own `redirect`. The default
  remains `"follow"`; `"manual"` enables callers to validate and pin every
  redirect hop for SSRF-safe fetching.

### Changed

- A session's cookie jar is now keyed by the `session` id alone instead of the
  full client cache key. The same `session` used with different
  `impersonate`/TLS/HTTP settings (or with `resolve`) now shares one jar,
  matching the browser-tab model; previously each distinct combination kept a
  separate, initially empty jar. Distinct `session` ids remain fully isolated,
  and `clearSession`/`clearClientCache` drop the shared jars as before.

### Security

- Cross-host redirect targets are intentionally never covered by an initial
  request's DNS pin. SSRF-sensitive callers must select `"manual"`, validate
  each `Location`, and issue the next request with a new pin. Pins are ignored
  with a proxy, where origin DNS resolution happens outside the direct client
  connection.

## [1.0.1] - 2026-07-14

First published release. 1.0.0 was tagged but never reached npm — its release
run failed while assembling the platform packages (see the build fix below).

### Fixed

- Release build: cross-compiled targets are now built for the requested
  platform. `pnpm run build -- --target <triple>` sent `--target` to Cargo
  instead of napi, so both cross jobs silently built for the host and emitted a
  wrong-named binary, leaving two platform packages empty and failing the
  release. Each build now also asserts it produced `fetch.<platform>.node`.
- `fetch(Request)` whose body was already consumed now throws `TypeError` per
  WHATWG, instead of silently sending a bodyless request.
- Response body pre-allocation no longer trusts `Content-Length`: a hostile
  value can no longer abort the process. The hint is clamped to
  `maxResponseBytes` and a 1 MiB ceiling.

### Changed

- `Response.bytes()` returns a view over the response buffer instead of copying
  it.
- Node 24 is now the minimum supported and CI-tested runtime.

### Removed

- Unused native `text()`/`json()` addon methods (the JS wrapper decodes off the
  buffer directly).

## [1.0.0] - 2026-07-12

### Added

- `fetch(url, options)` native addon (napi-rs + wreq/BoringSSL) with a
  Fetch-API-shaped call signature: `FetchResponse`/`FetchHeaders`,
  promise-returning body accessors (`text()`, `json()`, `arrayBuffer()`),
  `Headers.get()`/`.has()`.
- TLS/HTTP2 fingerprint impersonation via `impersonate`: native wreq-util
  profiles (e.g. `chrome_147`), all 19 curl-impersonate preset names
  (`listImpersonatePresets()`), or `random`/`weighted_random`.
- `proxy`, `session` (persistent per-client cookie jar), `timeoutMs`,
  `tlsMinVersion`/`tlsMaxVersion`, `httpVersion`, and a `tlsOptions` escape
  hatch (cipher/curve/sigalgs overrides) that composes with, rather than
  clobbers, the `impersonate` profile.
- `platform` override to change declared-platform headers
  (`sec-ch-ua-platform`, User-Agent) independently of the TLS fingerprint —
  verified not to diverge JA4.
- Process-wide client cache keyed by fingerprint-affecting options, bounded
  at 256 entries with LRU eviction; `clearSession()`/`clearClientCache()`
  for explicit cleanup.
- Streamed response bodies with a `maxResponseBytes` cap (default 32 MiB)
  instead of unbounded buffering; rejection of case-only duplicate request
  headers.
- `docker/` Linux-coherent deployment setup and
  `verify-tcp-coherence.js` to check TCP/IP-level fingerprint coherence
  against a live fingerprinting service.
- Test suite covering redirects, promise chaining, sessions, timeouts, and
  live JA4 verification against tls.peet.ws.

### Documentation

- Documented a known limitation: the TLS/HTTP fingerprint is spoofed and
  cross-validated against two independent fingerprinting services
  (tls.peet.ws, proxywing.com's networktest backend), but the TCP/IP-level
  fingerprint (TTL, window size, option order) reflects the real host
  kernel and cannot be spoofed from userspace — including the Docker
  Desktop for Mac caveat, where a Linux container's egress is NATed through
  the macOS host network stack and still reports macOS.
- Added `bench/` — a k6-driven benchmark suite comparing this module
  against Node's built-in `fetch`, plus an HTML report and methodology
  writeup under `docs/`.

[1.3.0]: https://github.com/x51xxx/fetch/releases/tag/v1.3.0
[1.2.1]: https://github.com/x51xxx/fetch/releases/tag/v1.2.1
[1.2.0]: https://github.com/x51xxx/fetch/releases/tag/v1.2.0
[1.1.0]: https://github.com/x51xxx/fetch/releases/tag/v1.1.0
[1.0.1]: https://github.com/x51xxx/fetch/releases/tag/v1.0.1
[1.0.0]: https://github.com/x51xxx/fetch/releases/tag/v1.0.0
