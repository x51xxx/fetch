# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/x51xxx/fetch/releases/tag/v1.1.0
[1.0.1]: https://github.com/x51xxx/fetch/releases/tag/v1.0.1
[1.0.0]: https://github.com/x51xxx/fetch/releases/tag/v1.0.0
