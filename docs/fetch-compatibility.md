[← Back to README](../README.md)

# `fetch` Compatibility & Migration Guide

`@trishchuk/fetch` is shaped like the WHATWG [`fetch`][whatwg] you already know (`fetch(input, init)`, a `FetchResponse` with `text()`/`json()`/`bytes()`/…), but its primary purpose is **TLS/HTTP2 fingerprint impersonation**, not being a full `undici` replacement. This document defines the precise compatibility contract: what maps 1:1 to native `fetch`, what differs on purpose, and what isn't supported yet. For the conceptual overview and fingerprint-specific use cases, see the [README](../README.md).

[whatwg]: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API

---

## TL;DR Feature Comparison

| Capability                                                   | Native `fetch`  | `@trishchuk/fetch` | Notes                                                                     |
| :----------------------------------------------------------- | :-------------: | :----------------: | :------------------------------------------------------------------------ |
| `fetch(input, init)` signature                               |       ✅        |         ✅         | Standard call syntax                                                      |
| `input`: URL string / `URL` / `Request`-like                 |       ✅        |         ✅         | A `Request`'s body is buffered, not streamed                              |
| Non-2xx resolves (no throw)                                  |       ✅        |         ✅         | Check `res.ok` / `res.status`                                             |
| Body: `string`                                               |       ✅        |         ✅         | UTF-8 encoded string bodies                                               |
| Body: `Uint8Array` / `Buffer` / `ArrayBuffer` / typed arrays |       ✅        |         ✅         | Raw binary payloads                                                       |
| Body: `URLSearchParams`                                      |       ✅        |         ✅         | Auto-sets `application/x-www-form-urlencoded`                             |
| Body: `Blob`                                                 |       ✅        |         ✅         | `Content-Type` taken from `blob.type`                                     |
| Body: `FormData` / multipart                                 |       ✅        |     ❌ throws      | Would diverge fingerprint — [why](#why-no-formdata)                       |
| Body: `ReadableStream` (streaming upload)                    |       ✅        |     ❌ throws      | Request body is buffered in memory                                        |
| Headers: `Headers` / array / object                          |       ✅        |         ✅         | Case-insensitive duplicate names combined                                 |
| Response `text` / `json` / `arrayBuffer` / `bytes` / `blob`  |       ✅        |         ✅         | `arrayBuffer()` returns Web `ArrayBuffer`                                 |
| Response body **re-readable**                                | ❌ (single-use) |    ✅ buffered     | Buffered mode only; with `stream: true` it is single-use like the spec    |
| `res.headers` = WHATWG `Headers`                             |       ✅        |         ✅         | Plus `res.rawHeaders` (original casing/order)                             |
| `res.body` (`ReadableStream`)                                |       ✅        | ✅ `stream: true`  | Opt-in; `null` in buffered mode — [streaming](#streaming-response-bodies) |
| `res.clone()`                                                |       ✅        |  ✅ buffered only  | Free (shares the native body); **throws** on a streamed response          |
| `res.formData()` / `res.type`                                |       ✅        |         ❌         | Not implemented                                                           |
| `AbortSignal` (`init.signal`)                                |       ✅        |         ✅         | Full WHATWG semantics — rejects with the signal's exact `reason`          |
| `redirect`                                                   |       ✅        |         ✅         | `follow`, `manual`, and `error`; defaults to `follow`                     |
| `credentials` / `mode` / `cache`                             |       ✅        |         ❌         | Ignored (no browser DOM context)                                          |
| **TLS/HTTP2 fingerprint control**                            |       ❌        |         ✅         | `impersonate`, `tlsOptions`, `platform`, ...                              |

---

## Call Signature and Inputs

```ts
fetch(input: string | URL | RequestLike, init?: FetchInit): Promise<FetchResponse>
```

`input` accepts:

- A URL **string**: `fetch('https://example.com/path')`
- A **`URL`** instance: `fetch(new URL('https://example.com/path'))`
- A **`Request`-like** object: anything with a string `url` property (such as global `Request` or `{ url, method, headers, body }`). Its `method`, `headers`, `redirect`, and `body` are read; the body is buffered via `arrayBuffer()`.

When both a `Request` object and `init` supply the same field, **`init` takes precedence** (WHATWG rules):

```js
const req = new Request('https://example.com/api', { method: 'PUT', body: 'a' })
await fetch(req, { method: 'POST', body: 'b' }) // → POST with body "b"
```

---

## Request Options (`init`)

`init` carries standard WHATWG fields plus fingerprint and transport extensions. Unknown WHATWG options (`mode`, `credentials`, `cache`, `integrity`, `referrer`, `keepalive`, `signal`) are accepted but ignored.

### WHATWG Fields

| Field      | Type                                                      | Default    | Notes                                                                                |
| :--------- | :-------------------------------------------------------- | :--------- | :----------------------------------------------------------------------------------- |
| `method`   | `string`                                                  | `"GET"`    | Standard names are upper-cased (`post` → `POST`); custom methods pass through as-is. |
| `headers`  | `Headers \| [string, string][] \| Record<string, string>` | none       | See [Request headers](#request-headers).                                             |
| `body`     | See [Request bodies](#request-bodies)                     | none       | Standard string, binary, or form payloads.                                           |
| `redirect` | `"follow" \| "manual" \| "error"`                         | `"follow"` | `"manual"` returns 3xx response; `"error"` rejects on redirect.                      |

### Fingerprint & Transport Extensions

See the [README use cases](../README.md#use-cases) for complete details.

| Field                             | Type                                 | Meaning                                                                             |
| :-------------------------------- | :----------------------------------- | :---------------------------------------------------------------------------------- |
| `impersonate`                     | `string`                             | Browser fingerprint profile (`"chrome_147"`, curl-impersonate presets, `"random"`). |
| `platform`                        | `string`                             | Declared OS for User-Agent/client-hint headers.                                     |
| `proxy`                           | `string`                             | Per-request proxy URL (`http://`, `https://`, `socks5://`).                         |
| `resolve`                         | `Record<string, string \| string[]>` | Pin hostnames to literal IP addresses.                                              |
| `session`                         | `string`                             | Opaque ID sharing cookie jar and cached client connections.                         |
| `timeoutMs`                       | `number`                             | Request timeout in milliseconds.                                                    |
| `maxResponseBytes`                | `number`                             | Response body buffer limit in bytes (default 32 MiB).                               |
| `tlsMinVersion` / `tlsMaxVersion` | `string`                             | TLS version bounds (`"1.0"` – `"1.3"`).                                             |
| `httpVersion`                     | `string`                             | Force `"http1"` or `"http2"`.                                                       |
| `tlsOptions`                      | `TlsOptionsOverride`                 | Raw ClientHello overrides — **diverges fingerprint**.                               |

---

## Request Bodies

Request body inputs are converted to UTF-8 strings or raw byte arrays before passing to the native layer. Default `Content-Type` headers are applied **only if omitted by the caller**.

| Body Input                                         | Sent As             | Default `Content-Type`                            |
| :------------------------------------------------- | :------------------ | :------------------------------------------------ |
| `string`                                           | UTF-8 text          | `undefined`                                       |
| `Uint8Array` / `Buffer` / typed array / `DataView` | Exact byte sequence | `undefined`                                       |
| `ArrayBuffer` / `SharedArrayBuffer`                | Backing bytes       | `undefined`                                       |
| `URLSearchParams`                                  | `key=val&...`       | `application/x-www-form-urlencoded;charset=UTF-8` |
| `Blob`                                             | Blob payload bytes  | `blob.type`                                       |
| `FormData`                                         | —                   | **Throws** ([why](#why-no-formdata))              |
| `ReadableStream`                                   | —                   | **Throws** (streaming uploads unsupported)        |
| `null` / `undefined`                               | No body             | `undefined`                                       |

```js
// Binary payload
await fetch(url, { method: 'PUT', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })

// Form payload (Content-Type auto-set)
await fetch(url, { method: 'POST', body: new URLSearchParams({ q: 'hello world' }) })

// Custom Content-Type overrides defaults
await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ a: 1 }),
})
```

A typed-array **view** sends only its slice, not the entire backing buffer:

```js
const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
await fetch(url, { method: 'POST', body: backing.subarray(2, 5) }) // Sends bytes 3, 4, 5
```

### Why No FormData

> [!WARNING]
> A real browser's multipart serialization (`----WebKitFormBoundary...` boundary tokens, part header casing, field order) forms part of its client fingerprint. Emitting a generic multipart body would introduce detectable signatures. Until browser-exact multipart serialization is implemented, `FormData` throws on input.
>
> If multipart support is required immediately, construct the body bytes manually and supply explicit `Content-Type: multipart/form-data; boundary=...` headers.

---

## Request Headers

`headers` accepts any WHATWG `HeadersInit`:

```js
await fetch(url, { headers: { 'x-a': '1' } }) // Plain object
await fetch(url, {
  headers: [
    ['x-a', '1'],
    ['x-b', '2'],
  ],
}) // Array of key-value pairs
await fetch(url, { headers: new Headers({ 'x-a': '1' }) }) // Headers instance
```

Case-insensitive duplicate header names are **combined** into a single comma-separated value per WHATWG `Headers.get` rules:

```js
// { 'x-id': 'one', 'X-Id': 'two' }  →  sent as:  x-id: one, two
```

Custom headers are overlaid onto the default impersonation profile headers.

---

## Response (`FetchResponse`)

| Member          | Type                   | Notes                                                          |
| :-------------- | :--------------------- | :------------------------------------------------------------- |
| `status`        | `number`               | HTTP status code.                                              |
| `statusText`    | `string`               | Canonical reason phrase from Rust `http` crate.                |
| `ok`            | `boolean`              | `true` if `status` is in `200..299`.                           |
| `url`           | `string`               | Final URL after following redirects.                           |
| `redirected`    | `boolean`              | `true` if final URL differs from requested.                    |
| `bodyUsed`      | `boolean`              | `true` after initial accessor call (advisory).                 |
| `headers`       | `Headers`              | WHATWG `Headers` instance.                                     |
| `rawHeaders`    | `FetchHeaders`         | Native header collection preserving original casing and order. |
| `text()`        | `Promise<string>`      | UTF-8 decoded text string.                                     |
| `json()`        | `Promise<any>`         | Parsed JSON object.                                            |
| `bytes()`       | `Promise<Uint8Array>`  | Raw body as `Uint8Array`.                                      |
| `blob()`        | `Promise<Blob>`        | `Blob` typed from response `Content-Type`.                     |
| `arrayBuffer()` | `Promise<ArrayBuffer>` | Web `ArrayBuffer`.                                             |
| `clone()`       | `FetchResponse`        | Independent view; copies the wrapper, not the payload.         |

> [!NOTE]
> Because response bodies are buffered in memory, accessors are **re-readable**. Sequential calls to `.text()` and `.json()` on the same response instance succeed without throwing.
>
> For the same reason `clone()` does **not** throw when `bodyUsed` is `true`, though WHATWG says it should. Refusing to clone a response you can still re-read would be a stricter rule for the weaker operation. Each clone keeps its own `bodyUsed` and `Headers`.

---

## Streaming Response Bodies

Passing `stream: true` returns a `StreamingFetchResponse` instead. Its metadata members are identical; the body differs — and it is **closer to the spec** than the buffered path, because it is genuinely one-shot.

| Member                                                       | Type                                 | Notes                                                                                               |
| :----------------------------------------------------------- | :----------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `body`                                                       | `ReadableStream<Uint8Array> \| null` | `null` for null-body statuses (101, 103, 204, 205, 304) and for `HEAD`/`CONNECT`.                   |
| `bodyUsed`                                                   | `boolean`                            | **Real, not advisory** — `true` once the stream was actually read or cancelled.                     |
| `text()` / `json()` / `bytes()` / `arrayBuffer()` / `blob()` | —                                    | One-shot; a second call throws `TypeError`. Each re-applies the 32 MiB cap, since they materialize. |
| `cancel()`                                                   | `Promise<void>`                      | Requests cancellation and releases the connection. Idempotent.                                      |
| `clone()`                                                    | `never`                              | Throws `TypeError` — use `response.body.tee()`.                                                     |
| `[Symbol.asyncDispose]()`                                    | `Promise<void>`                      | Supports `await using`.                                                                             |

**Differential parity.** Running the same 18 scenarios against Node's built-in `fetch` (`node test/undici-parity.mjs`):

| Mode               | Matches undici |
| :----------------- | :------------- |
| Buffered (default) | 15 / 18        |
| `stream: true`     | **17 / 18**    |

The streaming path closes three divergences the buffered path has — `204` → `body === null`, real `bodyUsed` with `TypeError` on a second read, and `res.body` as a `ReadableStream`. Its one remaining gap is `clone()`, which is deliberate (below).

**Deliberate divergences on the streaming path:**

- **`clone()` throws.** WHATWG defines it as `tee()`, which buffers the slower branch without bound — read one branch and ignore the other and you hold the whole body in memory, undoing the reason to stream. It would also break backpressure and cannot split the single cumulative `maxResponseBytes` counter. `response.body.tee()` remains available for callers who accept that cost.
- **Error timing.** `fetch()` resolves once headers arrive, so a mid-body failure rejects while reading the stream rather than rejecting `fetch()`. This is why streaming is opt-in rather than the default.
- **`maxResponseBytes` is unset by default** here (unbounded is the point), but an explicit value still applies cumulatively and an explicit `0` rejects the first non-empty chunk.
- **`await cancel()` is not a release barrier** while a reader holds the stream — it fires the cancellation token, which an in-flight read observes on its next poll.

---

## How It Differs from Native `fetch`

### Aligned Behavior

- Non-2xx status codes resolve normally (do not reject).
- `res.headers` is an instance of WHATWG `Headers`.
- `arrayBuffer()` returns a standard Web `ArrayBuffer`.

### Intentional Differences

- **Re-readable Bodies** (buffered mode): Calling multiple body accessors on a single response succeeds rather than throwing a single-use stream error. With `stream: true` the spec behaviour applies instead.
- **`clone()` on a streamed response throws**: `tee()` would buffer without bound. See [above](#streaming-response-bodies).
- **Error timing under `stream: true`**: mid-body failures reject the stream read, not the `fetch()` promise.
- **Abort semantics**: an abort rejects with the signal's exact `reason` (identity-preserved, per WHATWG — never wrapped in a `FetchError`); on a streamed response after headers, the body stream _errors_ with that reason rather than closing. Consumer cancellation (`reader.cancel()`, `response.cancel()`) stays a clean close. `timeoutMs` is independent of `AbortSignal.timeout()`: the former rejects with `FetchError` `code: 'TIMEOUT'`, the latter with its `TimeoutError` `DOMException`; when both are set the first to fire wins.
- **`redirect: 'manual'` Behavior**: Exposes 3xx status codes and `Location` headers directly to JS for per-hop validation.
- **`statusText`**: Standardized canonical status phrase instead of raw HTTP/1.x wire text.

### Unsupported Features

- `res.formData()` / `res.type`: Not implemented.
- `FormData` & `ReadableStream` **request** bodies: Both throw on attempt. (Response streaming _is_ supported via `stream: true`.)
- Browser-specific context options: `credentials`, `mode`, `cache`, `integrity`, `referrer`, `keepalive` are ignored.

---

## Migration Recipes

### From Native `fetch` / `undici`

```js
// Before
const res = await fetch('https://api.example.com/data', {
  headers: { authorization: `Bearer ${token}` },
})

// After (Impersonating Chrome)
const { fetch } = require('@trishchuk/fetch')
const res = await fetch('https://api.example.com/data', {
  headers: { authorization: `Bearer ${token}` },
  impersonate: 'chrome_147',
})
```

### Form Post with Session Cookie Tracking

```js
const res = await fetch('https://site.example/login', {
  method: 'POST',
  body: new URLSearchParams({ user, pass }),
  impersonate: 'chrome_147',
  session: 'user-42', // Persists cookie jar across calls
})
```

### Timeout Replacement for AbortController

```js
// Before:
// const ac = new AbortController()
// setTimeout(() => ac.abort(), 5000)
// fetch(url, { signal: ac.signal })

// After:
const res = await fetch(url, { timeoutMs: 5000 })
```

### Download Buffer with Custom Cap

```js
const res = await fetch(url, { maxResponseBytes: 64 * 1024 * 1024 })
const bytes = await res.bytes()
```

---

## Roadmap & Planned Features

Shipped in 1.2.0: **streaming response downloads** with end-to-end backpressure (`stream: true`) and `clone()` on buffered responses.

Shipped since: **native `AbortSignal` cancellation** wired into the Rust request futures — pre-flight, connect/TLS/headers, and per-chunk on both body paths; rejection (and streamed-body error) is the signal's own `reason`, identity-preserved.

Still planned:

1. **Streaming Uploads** (`ReadableStream` request body). Blocked on a design decision, not effort: without a known length HTTP/1.1 falls back to `Transfer-Encoding: chunked`, and browsers essentially never chunk uploads — so a naive implementation would be an observable fingerprint tell. The plan is to require a known length and make chunked an explicit opt-in.
2. **Browser-Exact `FormData` Serialization**.
3. **Zero-copy chunks** via `Bytes::try_into_mut()` on the streaming path, if measurement justifies it — a Node `Buffer` is writable while `Bytes` may share immutable storage, so it is only sound when unique ownership is proven.
