# @trishchuk/fetch

A **Fetch-API-shaped** HTTP client for Node.js, implemented as a Rust native addon (via [napi-rs](https://napi.rs) v3) on top of [`wreq`](https://github.com/0x676e67/wreq) — a hard fork of `reqwest` running on hyper + BoringSSL through the `btls` crate — and [`wreq-util`](https://github.com/0x676e67/wreq-util), which ships browser TLS and HTTP/2 fingerprint profiles.

[![npm version](https://img.shields.io/npm/v/@trishchuk/fetch.svg)](https://www.npmjs.com/package/@trishchuk/fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

The core purpose of this library is **TLS/HTTP2 fingerprint impersonation**: making outbound requests whose ClientHello (JA3/JA4) and HTTP/2 SETTINGS/priority frames (Akamai hash) match a real browser, not just an HTTP client that happens to have a `fetch()`-shaped API.

> [!NOTE]
> If you don't need fingerprint control, `undici` or native `fetch` will be faster to build and easier to deploy (no Rust toolchain, no BoringSSL). Use `@trishchuk/fetch` when the _shape of your TLS handshake_ is part of what you're testing or evading detection on.

It follows the WHATWG `fetch(input, init)` shape: `input` can be a URL string, a `URL`, or a `Request`-like object; request bodies accept `string`, `Uint8Array`/`Buffer`, `ArrayBuffer`, typed arrays, `URLSearchParams`, and `Blob`; request headers accept a `Headers` instance, an array of pairs, or a plain object; and the response carries a WHATWG `Headers` plus `text()`/`json()`/`arrayBuffer()`/`bytes()`/`blob()`/`clone()`.

Response bodies are **buffered by default** and capped at 32 MiB, which keeps error handling simple but makes large downloads impossible. Pass [`stream: true`](#8-streaming-a-large-download-to-disk) to get a real `ReadableStream` instead: peak memory then tracks the chunk size rather than the response size — **~206 MiB of RSS for a 2 GiB download, versus ~4.1 GiB buffered.**

It is still **not** a full drop-in replacement: `FormData`/multipart and streaming _request_ bodies aren't wired up yet. See [Known limitations](#known-limitations), and [`docs/fetch-compatibility.md`](./docs/fetch-compatibility.md) for the precise compatibility matrix and a migration guide from native `fetch`/`undici`.

---

## Table of Contents

- [Install & Build](#install--build)
- [Quick Start](#quick-start)
  - [Response vs. Transport Error Handling](#response-vs-transport-error-handling)
  - [Error Codes Summary](#error-codes-summary)
- [Use Cases](#use-cases)
  - [1. Basic Impersonated GET/POST](#1-basic-impersonated-getpost)
  - [2. Picking a curl-impersonate Preset](#2-picking-a-curl-impersonate-preset-and-inspecting-what-it-resolves-to)
  - [3. Multi-Request Session with Persistent Cookies](#3-multi-request-session-with-persistent-cookies-login-flow)
  - [4. Rotating Proxy per Request](#4-rotating-proxy-per-request)
  - [5. Timeout and Cancellation](#5-timeout-and-cancellation)
  - [6. Low-Level TLS Override (`tlsOptions`)](#6-low-level-tls-override-escape-hatch-tlsoptions)
  - [7. SSRF-Safe DNS Pinning and Manual Redirects](#7-ssrf-safe-dns-pinning-and-manual-redirects)
  - [8. Streaming a Large Download to Disk](#8-streaming-a-large-download-to-disk)
- [API Reference](#api-reference)
  - [`fetch(input, init)`](#fetchinput-init--promisefetchresponse)
  - [`FetchInit`](#fetchinit)
  - [`FetchResponse`](#fetchresponse)
  - [`StreamingFetchResponse`](#streamingfetchresponse)
  - [`clearSession` & `clearClientCache`](#clearsessionsession--number)
  - [`FetchHeaders`](#fetchheaders)
  - [`listImpersonatePresets()`](#listimpersonatepresets--impersonatepresetinfo)
  - [`TlsOptionsOverride`](#tlsoptionsoverride)
- [Known Limitations](#known-limitations)
- [How It Works](#how-it-works)
- [Benchmarks & Performance](#benchmarks--performance)
- [CI & Releasing](#ci--releasing)
- [Contributing](#contributing)
- [License](#license)

---

## Install & Build

Once published (see [Releasing](#ci--releasing)), `npm install @trishchuk/fetch` pulls a prebuilt `.node` binary for your platform via `optionalDependencies` — no Rust toolchain needed. Until then, or if you're working on this repo, build the native addon locally. You need:

- **Node.js**: tested on Node 24+
- **pnpm**: `packageManager: pnpm@10.26.2` in `package.json`
- **Rust Toolchain**: `cargo` (stable channel). Building compiles `wreq` against BoringSSL via `btls`, which additionally requires `cmake` and a C/C++ compiler on your `PATH` (see [`btls`/BoringSSL requirements](https://github.com/rust-lang/rust-bindgen#requirements) if the build fails looking for `clang`/`libclang`).

```bash
# Install Node dependencies
pnpm install

# Release build (optimized, LTO, stripped — slow compile due to LTO + BoringSSL)
pnpm run build

# Debug build (fast iteration, unoptimized binary)
pnpm run build:debug

# Run the test suite (node:test)
pnpm test

# Format (Prettier + cargo fmt) and lint (ESLint + cargo clippy)
pnpm run format
pnpm run lint
```

Both build commands emit a platform-specific binary (e.g. `fetch.darwin-arm64.node`) plus the generated loader `binding.js` / `binding.d.ts`, which the hand-authored `index.js` wrapper loads at require time. `napi.targets` in `package.json` lists the platforms this crate is set up to cross-compile for; you still need the matching Rust target installed to actually build one.

---

## Quick Start

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

### Response vs. Transport Error Handling

`fetch()` never rejects on a non-2xx HTTP response — that's a normal `FetchResponse` with `ok: false`. It only rejects on conditions that prevent a response from existing: connection/timeout failure, unknown `impersonate` name, invalid `proxy` URL, or malformed options like `tlsMinVersion`.

- Check `res.ok` / `res.status` for HTTP-level responses.
- Use `try/catch` for transport-level failures.

```js
const res = await fetch('https://example.com/api')
if (!res.ok) {
  throw new Error(`request failed: ${res.status} ${res.statusText}`)
}
const data = await res.json()
```

Transport-level rejections throw a `FetchError` carrying a stable `code`, allowing proxy rotation and retry logic to branch cleanly:

```js
const { fetch, FetchError } = require('@trishchuk/fetch')

try {
  const res = await fetch(url, { proxy })
  // ...
} catch (err) {
  if (err instanceof FetchError && err.code === 'PROXY_CONNECT') {
    // Proxy connection failed — rotate proxy and retry
  } else {
    throw err
  }
}
```

### Error Codes Summary

| Code                 | Cause & Recommended Action                                                     |
| :------------------- | :----------------------------------------------------------------------------- |
| `PROXY_CONNECT`      | Connection to proxy failed (refused/reset). Treat proxy as dead and rotate.    |
| `CONNECT`            | Connection to origin failed, or TLS handshake/cert failure.                    |
| `TIMEOUT`            | `timeoutMs` elapsed (stage-agnostic: proxy, origin, TLS, or response wait).    |
| `CONNECTION_RESET`   | Connection reset by peer during request or response.                           |
| `REDIRECT`           | Redirect limit exceeded or invalid redirect location when `redirect: 'error'`. |
| `DECODE`             | Response decompression failure (gzip, deflate, br, zstd).                      |
| `BODY`               | Error reading or buffering response body stream.                               |
| `REQUEST`            | Invalid request parameter or wire construction issue.                          |
| `REQUEST_FAILED`     | Uncategorized transport failure. The raw native error is kept on `err.cause`.  |
| `RESPONSE_TOO_LARGE` | Response body exceeded `maxResponseBytes` limit.                               |
| `InvalidArg`         | Option validation rejection (`Error`/`TypeError` with `code: 'InvalidArg'`).   |

---

## Use Cases

### 1. Basic Impersonated GET/POST

Every call automatically impersonates a browser — `chrome_147` is the default when `impersonate` is omitted.

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

Standard WHATWG `fetch(input, init)` body types and inputs work seamlessly:

```js
// URL object or Request-like input
await fetch(new URL('https://example.com/page'))
await fetch(new Request('https://example.com/api', { method: 'POST', body: 'hi' }))

// Form-encoded body (Content-Type set automatically)
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

// Headers instance & response accessors
const res = await fetch('https://example.com/data', {
  headers: new Headers({ accept: 'application/json' }),
})
res.headers.get('content-type') // WHATWG Headers
const bytes = await res.bytes() // Uint8Array; also blob(), arrayBuffer(), text(), json()
```

### 2. Picking a curl-impersonate Preset and Inspecting What It Resolves To

`impersonate` accepts all 19 preset names from [curl-impersonate](https://github.com/lwthiker/curl-impersonate)'s `browsers.json` (`chrome116`, `ff109`, `safari15_5`, ...). `listImpersonatePresets()` returns details on how each maps to native `wreq-util` profiles:

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

> [!NOTE]
> 11 of the 19 presets are `exact: true` (wreq-util has a profile for that precise version). The other 8 predate wreq-util's oldest profile per browser family (pre-2022) and resolve to the closest newer profile available (nearest-neighbor approximation). Check `exact` if your fingerprint must be byte-exact to an older version.

### 3. Multi-Request Session with Persistent Cookies (Login Flow)

Pass the same `session` ID on calls that should share a cookie jar:

```js
const { fetch } = require('@trishchuk/fetch')

const session = 'user-42' // Scope per logical user/session

const login = await fetch('https://example.com/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user: 'alice', pass: 'hunter2' }),
  session,
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)

// Same session ID -> same cookie jar, preserving Set-Cookie headers
const profile = await fetch('https://example.com/account', { session })
console.log(await profile.json())
```

> [!TIP]
> Calls without `session` are stateless and isolated — they never share cookies with other requests.

### 4. Rotating Proxy per Request

`proxy` is applied per call, independent of client caching — it does not change client/session reuse:

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

### 5. Timeout and Cancellation

```js
const { fetch } = require('@trishchuk/fetch')

try {
  const res = await fetch('https://example.com/slow', { timeoutMs: 5000 })
} catch (err) {
  console.error('request timed out or failed:', err.message)
}
```

`AbortSignal` is supported with WHATWG semantics: the rejection (or, mid-stream,
the body error) is the signal's own `reason`, identity-preserved. Compose
multiple sources with the standard primitives instead of a custom API:

```js
const controller = new AbortController() // e.g. wired to user action / shutdown

try {
  const res = await fetch('https://example.com/slow', {
    // First to fire wins: user abort, a 5 s deadline, or `timeoutMs` below.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })
} catch (err) {
  // controller.abort(reason)  -> rejects with that exact `reason`
  // AbortSignal.timeout()     -> DOMException named "TimeoutError"
  // timeoutMs                 -> FetchError with code "TIMEOUT"
  console.error('aborted or failed:', err)
}
```

### 6. Low-Level TLS Override Escape Hatch (tlsOptions)

`tlsOptions` allows tuning specific ClientHello fields on top of an `impersonate` profile:

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

> [!WARNING]
> **Overriding ClientHello fields diverges the TLS fingerprint.** Unset fields keep the preset profile's values (verified empirically — overriding `cipherList` leaves curves, Akamai hash, and User-Agent intact), but every set field alters the byte pattern relative to real browsers. Use `tlsOptions` only when strictly necessary.

### 7. SSRF-Safe DNS Pinning and Manual Redirects

`resolve` pins target hostnames to specific IP addresses, mitigating DNS rebinding attacks while keeping SNI, TLS validation, and `Host` intact:

```js
const dns = require('node:dns').promises
const { fetch } = require('@trishchuk/fetch')

async function ssrfSafeFetch(input, maxRedirects = 10) {
  let url = new URL(input)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const dnsHost = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
    const { address } = await dns.lookup(dnsHost)
    assertPublicAddress(address) // Custom validation policy

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

> [!IMPORTANT]
>
> - `resolve` map pins are **never automatically extended** to cross-host redirects. Use `redirect: "manual"` and repeat DNS resolution, validation, and pinning for each `Location`.
> - `resolve` is ignored when `proxy` is set (the proxy resolves origin hostnames). Combining both triggers a one-time `MYFETCH_RESOLVE_IGNORED` process warning.
> - Pinned requests are pooled per host + address set, so pinning every request keeps keep-alive connections warm. The guarantee is per pin: a pooled client never connects **the pinned host** to an address outside its set. Any _other_ hostname the client reaches (e.g. a followed redirect) goes through system DNS, exactly as before — which is why the loop above uses `redirect: "manual"`.

### 8. Streaming a Large Download to Disk

By default the whole body is buffered in memory and rejected past `maxResponseBytes` (32 MiB). Pass `stream: true` and `response.body` becomes a WHATWG `ReadableStream<Uint8Array>`, so the file never has to fit in RAM:

```js
import { fetch } from '@trishchuk/fetch'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const response = await fetch('https://example.com/huge.iso', {
  impersonate: 'chrome_147',
  stream: true,
})
if (!response.ok) throw new Error(`HTTP ${response.status}`)

await pipeline(Readable.fromWeb(response.body), createWriteStream('huge.iso'))
```

Backpressure is real and end-to-end: when the disk can't keep up, `pipeline` stops pulling, so no native read is issued, so the TCP window closes. Memory stays bounded by the chunk size no matter how large the file is.

You can also consume it directly, computing as you go instead of collecting:

```js
import { createHash } from 'node:crypto'

const response = await fetch(url, { stream: true })
const hash = createHash('sha256')
let bytes = 0
for await (const chunk of response.body) {
  bytes += chunk.length
  hash.update(chunk)
}
console.log(bytes, hash.digest('hex'))
```

**Measured** with `node bench/memory-large-file.mjs 256 1024 2048`:

| Response size | Peak RSS, `stream: true` | Peak RSS, buffered |
| ------------- | ------------------------ | ------------------ |
| 256 MiB       | **182 MiB**              | 580 MiB            |
| 1 GiB         | **202 MiB**              | 2115 MiB           |
| 2 GiB         | **206 MiB**              | 4142 MiB           |

Streaming stays flat while the body grows 8x; buffering costs roughly 2x the body, because it is held once as a `Vec<u8>` in Rust and again as a copy in V8.

> [!NOTE]
> Numbers measured on an **Apple M3 Max (arm64), 16 cores, 48 GB RAM, macOS 26.3, Node v24.18.0**, against a loopback server — no network involved. Treat them as the shape of the difference rather than portable absolutes: the buffered column varies 20–25% between runs with GC timing, and both columns will shift on other hardware, kernels, and allocators. The flatness of the streaming column is the reproducible part. Re-run the benchmark on your own target before quoting a figure.

> [!IMPORTANT]
> Streaming is opt-in because it **changes when errors surface**. Buffered, `fetch()` cannot resolve until the body is fully read, so a mid-body failure rejects the `fetch()` promise. With `stream: true` the promise resolves as soon as headers arrive, so the same failure rejects while you read the stream. Wrap the read, not just the call.

> [!NOTE]
> The TLS/HTTP2 fingerprint is identical in both modes — both share one request-building path in Rust, and JA4, the Akamai HTTP/2 hash, and peetprint come out byte-identical. Reading slowly does not change the handshake.

Other differences on a streamed response: the body is genuinely one-shot (`bodyUsed` is real, a second accessor throws), null-body statuses and `HEAD` give `body === null`, `clone()` throws (use `response.body.tee()`), and `maxResponseBytes` is **unset by default** — though `text()`/`json()`/`bytes()`/`arrayBuffer()`/`blob()` still re-apply the 32 MiB cap, since they materialize the body. See [`StreamingFetchResponse`](#streamingfetchresponse).

---

## API Reference

The public API is the ergonomic wrapper in `index.js` (typed by `index.d.ts`), which wraps the NAPI-generated native binding (`binding.js` / `binding.d.ts`, produced from `src/lib.rs`). See [`docs/fetch-compatibility.md`](./docs/fetch-compatibility.md) for full comparison details with native `fetch`.

### `fetch(input, init?) => Promise<FetchResponse>`

Primary entry point. `input` can be a URL string, `URL`, or `Request`-like object. `init` options override any corresponding fields present on a `Request` input.

### `FetchInit`

| Field              | Type                                                                                | Default               | Meaning                                                                                                                                                                                                   |
| :----------------- | :---------------------------------------------------------------------------------- | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`           | `string`                                                                            | `"GET"`               | HTTP method.                                                                                                                                                                                              |
| `headers`          | `Headers \| [string, string][] \| Record<string, string>`                           | `undefined`           | Request headers. Case-insensitive duplicate names are combined with `", "`.                                                                                                                               |
| `body`             | `string \| Uint8Array \| ArrayBuffer \| ArrayBufferView \| URLSearchParams \| Blob` | `undefined`           | Request body. `URLSearchParams` and `Blob` auto-set default `Content-Type`. No `FormData`/streams.                                                                                                        |
| `impersonate`      | `string`                                                                            | `"chrome_147"`        | Fingerprint profile name (`"chrome_147"`, `"safari_26"`, curl-impersonate presets like `"chrome116"`, or `"random"` / `"weighted_random"`).                                                               |
| `platform`         | `string`                                                                            | profile default       | Declared OS for User-Agent/client-hint headers (`"windows"`, `"macos"`, `"linux"`, `"android"`, `"ios"`).                                                                                                 |
| `proxy`            | `string`                                                                            | `undefined`           | Proxy URL (`http://`, `https://`, or `socks5://`).                                                                                                                                                        |
| `resolve`          | `Record<string, string \| string[]>`                                                | `undefined`           | Hostname IP pinning map. Ignored when `proxy` is set.                                                                                                                                                     |
| `redirect`         | `"follow" \| "manual" \| "error"`                                                   | `"follow"`            | WHATWG redirect policy.                                                                                                                                                                                   |
| `session`          | `string`                                                                            | `undefined`           | Opaque session ID for cookie jar and client caching.                                                                                                                                                      |
| `timeoutMs`        | `number`                                                                            | `undefined`           | Request timeout in milliseconds.                                                                                                                                                                          |
| `signal`           | `AbortSignal \| null`                                                               | `undefined`           | WHATWG abort. Rejects (or errors a streamed body) with the signal's own `reason`. Compose sources with `AbortSignal.any()` / `AbortSignal.timeout()`; `null` disables a `Request`-inherited signal.       |
| `maxResponseBytes` | `number`                                                                            | `33,554,432` (32 MiB) | Maximum response body buffer size in bytes. With `stream: true` it is **unset by default**; an explicit value becomes a cumulative cap, and an explicit `0` rejects the first non-empty chunk.            |
| `stream`           | `boolean`                                                                           | `false`               | Do not buffer the body. Returns a [`StreamingFetchResponse`](#streamingfetchresponse) whose `body` is a `ReadableStream`. Changes error timing — see [use case 8](#8-streaming-a-large-download-to-disk). |
| `tlsMinVersion`    | `string`                                                                            | profile default       | Minimum TLS version (`"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`).                                                                                                                                                 |
| `tlsMaxVersion`    | `string`                                                                            | profile default       | Maximum TLS version.                                                                                                                                                                                      |
| `httpVersion`      | `string`                                                                            | ALPN negotiated       | Force `"http1"` or `"http2"`.                                                                                                                                                                             |
| `tlsOptions`       | `TlsOptionsOverride`                                                                | `undefined`           | ClientHello field overrides.                                                                                                                                                                              |

> [!NOTE]
>
> - **Client-level options** (determine cached client selection): `impersonate`, `platform`, `session`, `tlsMinVersion`, `tlsMaxVersion`, `httpVersion`, `tlsOptions`.
> - **Per-request options** (do not affect client caching): `method`, `headers`, `body`, `proxy`, `redirect`, `timeoutMs`.

### `FetchResponse`

| Member          | Type                    | Meaning                                                             |
| :-------------- | :---------------------- | :------------------------------------------------------------------ |
| `status`        | `number` (readonly)     | HTTP status code.                                                   |
| `statusText`    | `string` (readonly)     | Canonical reason phrase from the `http` crate status table.         |
| `ok`            | `boolean` (readonly)    | `true` if `status` is in `200..299`.                                |
| `url`           | `string` (readonly)     | Final URL after redirects.                                          |
| `redirected`    | `boolean` (readonly)    | `true` if redirected.                                               |
| `bodyUsed`      | `boolean` (readonly)    | `true` once any body accessor has been called.                      |
| `headers`       | `Headers` (getter)      | Response headers as a WHATWG `Headers` instance.                    |
| `rawHeaders`    | `FetchHeaders` (getter) | Native header collection preserving server casing and header order. |
| `text()`        | `Promise<string>`       | UTF-8 decoded body string.                                          |
| `json()`        | `Promise<any>`          | Parsed JSON object.                                                 |
| `bytes()`       | `Promise<Uint8Array>`   | Body as a `Uint8Array`.                                             |
| `blob()`        | `Promise<Blob>`         | Body as a `Blob` typed from `Content-Type`.                         |
| `arrayBuffer()` | `Promise<ArrayBuffer>`  | Body as a Web `ArrayBuffer`.                                        |
| `clone()`       | `FetchResponse`         | Independent view over the same response. Copies no payload.         |

> [!TIP]
> Response bodies are buffered in memory, making body accessors **re-readable**. Calling `.text()` and subsequently `.json()` on the same response succeeds.
>
> For the same reason `clone()` is nearly free — it duplicates the wrapper, not the body — and, unlike WHATWG, it does **not** throw when `bodyUsed` is `true`. Refusing to clone a response you can still re-read would be a stricter rule for the weaker operation. Each copy keeps its own `bodyUsed` and its own `Headers`.

### `StreamingFetchResponse`

Returned instead of `FetchResponse` when `stream: true` is passed. Same metadata, but the body is still on the wire — see [use case 8](#8-streaming-a-large-download-to-disk).

| Member                                                       | Type                                 | Meaning                                                                                                          |
| :----------------------------------------------------------- | :----------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `status` / `statusText` / `ok` / `url` / `redirected`        | —                                    | As on `FetchResponse`.                                                                                           |
| `headers` / `rawHeaders`                                     | —                                    | As on `FetchResponse`. Available before any body byte is read.                                                   |
| `body`                                                       | `ReadableStream<Uint8Array> \| null` | The body. `null` for null-body statuses (101, 103, 204, 205, 304) and for `HEAD`/`CONNECT`.                      |
| `bodyUsed`                                                   | `boolean` (readonly)                 | Real, not advisory: `true` once the stream has actually been read or cancelled.                                  |
| `text()` / `json()` / `bytes()` / `arrayBuffer()` / `blob()` | —                                    | One-shot. A second call throws `TypeError`. Each **re-applies the 32 MiB cap**, since they materialize the body. |
| `cancel()`                                                   | `Promise<void>`                      | Requests cancellation and releases the connection. Idempotent.                                                   |
| `clone()`                                                    | `never`                              | Always throws `TypeError` — use `response.body.tee()` instead.                                                   |
| `[Symbol.asyncDispose]()`                                    | `Promise<void>`                      | Enables `await using response = await fetch(url, { stream: true })`.                                             |

> [!WARNING]
> `clone()` throws here on purpose. WHATWG defines it as `tee()`, and `tee()` buffers the slower branch **without bound** — read one branch, ignore the other, and you hold the entire body in memory, undoing the reason to stream at all. It would also break backpressure and cannot split the single cumulative `maxResponseBytes` counter. Call `response.body.tee()` yourself if you accept that cost.

> [!NOTE]
> `await cancel()` is not a resource-release barrier while a reader holds the stream: it fires the native cancellation token, which an in-flight read observes on its next poll and only then drops the body. Awaiting it means cancellation was requested, not that the socket is already closed.

### `clearSession(session)` => `number`

Drops every cached client for `session`, including its in-memory cookie jar. Returns the number of cached client variants removed. Use this on logout or when a session ID is no longer valid. `clearClientCache()` clears every cached client across the process.

### `FetchHeaders`

Case-insensitive native header container preserving original casing and order (available via `res.rawHeaders`):

| Method      | Returns                   | Notes                                                      |
| :---------- | :------------------------ | :--------------------------------------------------------- |
| `get(name)` | `string \| null`          | Case-insensitive lookup; multi-headers joined with `", "`. |
| `has(name)` | `boolean`                 | Case-insensitive check.                                    |
| `entries()` | `Array<[string, string]>` | All header pairs `[name, value]` in original order.        |
| `keys()`    | `string[]`                | All header names in original order.                        |
| `values()`  | `string[]`                | All header values in original order.                       |

### `listImpersonatePresets() => ImpersonatePresetInfo[]`

Returns an array of preset descriptions for all 19 curl-impersonate profile names:

| Field            | Type      | Meaning                                                                   |
| :--------------- | :-------- | :------------------------------------------------------------------------ |
| `name`           | `string`  | Preset name (e.g. `"chrome116"`).                                         |
| `profile`        | `string`  | Resolved `wreq-util` profile (e.g. `"chrome_116"`).                       |
| `platform`       | `string`  | Emulated OS platform (`"windows"`, `"macos"`, `"android"`).               |
| `browserVersion` | `string`  | Target browser version.                                                   |
| `exact`          | `boolean` | `true` if exact version match; `false` if nearest-neighbor approximation. |

### `TlsOptionsOverride`

| Field               | Type      | Meaning                                      |
| :------------------ | :-------- | :------------------------------------------- |
| `cipherList`        | `string`  | OpenSSL-format cipher list string.           |
| `curvesList`        | `string`  | OpenSSL-format supported curves list string. |
| `sigalgsList`       | `string`  | OpenSSL-format signature algorithms string.  |
| `permuteExtensions` | `boolean` | Randomize ClientHello extension order.       |
| `sessionTicket`     | `boolean` | Enable/disable RFC 5077 TLS session tickets. |

---

## Known Limitations

- **Buffered Bodies by Default**: Response bodies are materialized in memory and capped at 32 MiB (configurable via `maxResponseBytes`). Pass [`stream: true`](#8-streaming-a-large-download-to-disk) to stream instead, which lifts the cap and makes multi-GB downloads practical. Note the trade-off: streaming moves mid-body errors from the `fetch()` promise to the stream read.
- **No Streaming Request Bodies**: Upload bodies are still buffered. A streaming request body would need a known length, because HTTP/1.1 falls back to `Transfer-Encoding: chunked` without one and browsers essentially never chunk uploads — an observable fingerprint difference. Deferred rather than shipped half-right.
- **No `clone()` on a Streamed Response**: It throws. `clone()` means `tee()`, which buffers the slower branch without bound. Use `response.body.tee()` explicitly.
- **No `FormData`/Multipart Request Bodies**: `FormData` throws on input. Generic multipart formatting diverges from browser-specific boundary and casing patterns.
- **`tlsOptions` Diverges Fingerprints**: Overriding ClientHello options changes the signature relative to authentic browser traffic.
- **No Direct Cookie Manipulation**: Cookies are managed transparently within a `session`; there is no API to read or write individual cookie strings directly.
- **Header Repetition Restrictions**: Duplicate request header keys are combined into comma-separated values per WHATWG rules.
- **`statusText` Standardization**: Returns canonical reason phrases from the Rust `http` crate table rather than raw wire bytes (HTTP/2 has no wire status text).
- **TCP/IP Handshake Exposure**:

> [!WARNING]
> **TCP/IP-level fingerprints reveal the true host OS.**
> Fingerprinting tools (e.g., p0f, ProxyWing) evaluate TCP handshake properties (SYN packet TTL, window size, MSS, option ordering) below the TLS layer. Changing `impersonate` modifies TLS/HTTP2 signatures (`ja4`, `user_agent`), but `tcpip.os_guess` remains tied to the underlying host OS.
>
> Running inside Docker on macOS still reports `macOS / iOS` because Docker Desktop NATs traffic through the host macOS network stack. True OS coherence requires running on a native host or VM matching the target OS. See `docker/verify-tcp-coherence.js` for testing tooling.

---

## How It Works

`@trishchuk/fetch` leverages [`wreq`](https://github.com/0x676e67/wreq) running on `hyper` with BoringSSL (via `btls`) to reproduce exact ClientHello byte layouts and HTTP/2 settings frames from real browser releases.

```
JS Application
  └── index.js (WHATWG wrapper)
       └── binding.js / fetch.<platform>.node (NAPI-RS v3 Addon)
            └── src/lib.rs (Rust client manager & LRU cache)
                 └── wreq + wreq-util (BoringSSL & Browser Emulation Profiles)
```

1. **Client Caching & LRU**: Each unique configuration key (`impersonate`, `platform`, `session`, `tlsMinVersion`, `tlsMaxVersion`, `httpVersion`, `tlsOptions`) maps to a cached `wreq::Client` in an LRU cache (bounded to 256 instances).
2. **Session Cookie Jars**: Cookie storage is keyed by `session` ID alone across client instances, allowing cookie persistence even when changing impersonation settings or using `resolve`.
3. **Random Impersonation**: `random` / `weighted_random` profiles pin their selected profile to the client cache key on first invocation, maintaining consistent fingerprints throughout a session.
4. **Pinned Client Pool**: A request whose `resolve` map has an entry for the URL's host adds that pin — the host exactly as written in the URL plus the **sorted, de-duplicated** address set — to its cache key, so repeated pinned requests reuse one client and its warm TCP/TLS/HTTP-2 connections. The DNS override is installed from the key alone, so a pooled connection can never lead to an address outside the pin it was opened for: a different validated address set is a different client. Pinned clients live in a separate, smaller LRU (128 instances) because their keys are high-cardinality (one per host × address set) — a crawler touching thousands of hosts cannot evict the few long-lived unpinned/session clients. A `resolve` map with no entry for the URL's host behaves exactly like no `resolve` at all.
5. **Compression**: `Accept-Encoding` is the impersonated profile's own header, verbatim and in its own position (`chrome_147` → `gzip, deflate, br, zstd`; `okhttp_5` → `gzip`) — not a value derived from which decoders are compiled in. Responses are decoded transparently and the encoding headers are stripped. `deflate` is accepted in **both** readings of the token: zlib-wrapped (RFC 1950) and raw (RFC 1951, what PHP/Apache `zlib.output_compression` sends), picked by sniffing the first two bytes. Browsers accept either, so impersonating one means matching that tolerance rather than the stricter spec.

### Empirically Verified Behavior

Tested against `https://tls.peet.ws/api/all` and `https://networktest.proxywing.com:8443/api/all`:

- Custom headers do not alter the HTTP/2 Akamai hash signature.
- `chrome116` preset matches official `curl_chrome116` request headers nearly byte-for-byte.
- JA4 first segment updates on session resumption without breaking fingerprint equality.
- `chrome_147` generates identical JA4 signatures (`t13d1516h2_8daaf6152771_d8a2da3f94cd`) across independent inspection endpoints.

---

## Benchmarks & Performance

Load testing with `k6` comparing Node's native `fetch` (`undici`) against `@trishchuk/fetch` (`wreq`/BoringSSL):

| Benchmark Scenario                       | Native `fetch` (`undici`)           | `@trishchuk/fetch`                        | Advantage                  |
| :--------------------------------------- | :---------------------------------- | :---------------------------------------- | :------------------------- |
| **2MB Payload @ 1000 req/s** (Sustained) | 636 req/s (14.7% errors, p95 1.77s) | **999.9 req/s (0.00% errors, p95 3.3ms)** | **536× lower p95 latency** |
| **512B Payload, 1 VU** (Low Concurrency) | 606 req/s                           | **3,252 req/s**                           | **5.4× throughput**        |
| **Cold HTTPS Handshake** (n=50, median)  | 107.4 ms                            | **62.8 ms**                               | **1.7× faster setup**      |

For complete benchmark methodology, charts, and reproduction steps, see [`docs/benchmark-native-vs-wreq.md`](./docs/benchmark-native-vs-wreq.md) and [`docs/benchmark-report.html`](./docs/benchmark-report.html).

---

## CI & Releasing

Multi-platform binaries are compiled via GitHub Actions (`.github/workflows/build.yml`) for:

- `x86_64-apple-darwin` & `aarch64-apple-darwin`
- `x86_64-unknown-linux-gnu` & `aarch64-unknown-linux-gnu`
- `x86_64-pc-windows-msvc`

### Cutting a Release

> [!IMPORTANT]
> To publish a new release:
>
> 1. Update `version` in `package.json`.
> 2. Commit and tag as `v<version>` (must match `package.json` version string).
> 3. Push tag to GitHub (`git push origin v<version>`).

The `release.yml` workflow automatically builds all targets, validates binary artifacts, updates platform packages in `npm/`, and publishes packages to npm using `NPM_TOKEN`.

---

## Contributing

Contributions and issue reports are welcome.

- See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor listings.
- See [CHANGELOG.md](CHANGELOG.md) for version release notes.

---

## License

[MIT](LICENSE) © Taras Trishchuk
