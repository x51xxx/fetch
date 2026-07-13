# `fetch` compatibility & migration guide

`@trishchuk/fetch` is shaped like the WHATWG [`fetch`][whatwg] you already know
(`fetch(input, init)`, a `FetchResponse` with `text()`/`json()`/`bytes()`/…),
but its reason to exist is **TLS/HTTP2 fingerprint impersonation**, not being a
full `undici` replacement. This document is the precise compatibility contract:
what maps 1:1 to native `fetch`, what differs on purpose, and what isn't there
yet. For the conceptual overview and the fingerprint-specific use cases, see the
[README](../README.md).

[whatwg]: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API

## TL;DR

| Capability                                                   | Native `fetch`  | `@trishchuk/fetch` | Notes                                                   |
| ------------------------------------------------------------ | --------------- | ------------------ | ------------------------------------------------------- |
| `fetch(input, init)` signature                               | ✅              | ✅                 |                                                         |
| `input`: URL string / `URL` / `Request`-like                 | ✅              | ✅                 | A `Request`'s body is buffered, not streamed            |
| Non-2xx resolves (no throw)                                  | ✅              | ✅                 | Check `res.ok` / `res.status`                           |
| Body: `string`                                               | ✅              | ✅                 |                                                         |
| Body: `Uint8Array` / `Buffer` / `ArrayBuffer` / typed arrays | ✅              | ✅                 |                                                         |
| Body: `URLSearchParams`                                      | ✅              | ✅                 | Auto `Content-Type`                                     |
| Body: `Blob`                                                 | ✅              | ✅                 | `Content-Type` from `blob.type`                         |
| Body: `FormData` / multipart                                 | ✅              | ❌ throws          | Would diverge the fingerprint — [why](#why-no-formdata) |
| Body: `ReadableStream` (streaming upload)                    | ✅              | ❌ throws          | Buffered only                                           |
| Headers: `Headers` / array / object                          | ✅              | ✅                 | Case-insensitive dupes combined                         |
| Response `text` / `json` / `arrayBuffer` / `bytes` / `blob`  | ✅              | ✅                 | `arrayBuffer()` → real `ArrayBuffer`                    |
| Response body **re-readable**                                | ❌ (single-use) | ✅                 | Buffered, so a 2nd read works                           |
| `res.headers` = WHATWG `Headers`                             | ✅              | ✅                 | Plus `res.rawHeaders` (original casing/order)           |
| `res.body` (`ReadableStream`)                                | ✅              | ❌                 | Buffered; no streaming download                         |
| `res.clone()` / `res.formData()` / `res.type`                | ✅              | ❌                 | `clone()` rarely needed (re-readable)                   |
| `AbortSignal` (`init.signal`)                                | ✅              | ❌ no-op           | Use `timeoutMs`; real cancel is planned                 |
| `redirect` / `credentials` / `mode` / `cache`                | ✅              | ❌                 | Always follows redirects; no browser context            |
| **TLS/HTTP2 fingerprint control**                            | ❌              | ✅                 | The whole point — `impersonate`, `tlsOptions`, …        |

## Call signature and inputs

```ts
fetch(input: string | URL | RequestLike, init?: FetchInit): Promise<FetchResponse>
```

`input` is one of:

- a URL **string** — `fetch('https://example.com/path')`
- a **`URL`** — `fetch(new URL('https://example.com/path'))`
- a **`Request`-like** object — anything with a string `url` (a global
  `Request`, or your own `{ url, method, headers, body }`). Its `method`,
  `headers`, and `body` are read; the body is buffered via `arrayBuffer()`.

When both a `Request` and `init` supply the same field, **`init` wins** (WHATWG
precedence):

```js
const req = new Request('https://example.com/api', { method: 'PUT', body: 'a' })
await fetch(req, { method: 'POST', body: 'b' }) // → POST with body "b"
```

## Request options (`init`)

`init` carries the WHATWG fields the wrapper understands **plus** this package's
fingerprint/transport options. Unknown WHATWG fields (`mode`, `credentials`,
`cache`, `integrity`, `referrer`, `keepalive`, `redirect`, `signal`) are
accepted but ignored — see [Differences](#how-it-differs-from-native-fetch).

### WHATWG fields

| Field     | Type                                                    | Default | Notes                                                                               |
| --------- | ------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `method`  | `string`                                                | `"GET"` | Standard names are upper-cased (`post` → `POST`); custom methods pass through as-is |
| `headers` | `Headers \| [string,string][] \| Record<string,string>` | none    | See [Request headers](#request-headers)                                             |
| `body`    | see [Request bodies](#request-bodies)                   | none    |                                                                                     |

### Fingerprint / transport extensions

These have no native-`fetch` equivalent — they're why this package exists.
Full semantics and worked examples live in the [README use cases](../README.md#use-cases).

| Field                             | Type     | Meaning                                                                                       |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `impersonate`                     | `string` | Browser fingerprint to emulate (`"chrome_147"` default, curl-impersonate presets, `"random"`) |
| `platform`                        | `string` | Declared OS for UA/client-hint headers; does **not** diverge the TLS fingerprint              |
| `proxy`                           | `string` | Per-request proxy (`http`/`https`/`socks5`, optional userinfo)                                |
| `session`                         | `string` | Opaque id; calls sharing it reuse one client + cookie jar                                     |
| `timeoutMs`                       | `number` | Overall request timeout                                                                       |
| `maxResponseBytes`                | `number` | Response buffer cap (default 32 MiB)                                                          |
| `tlsMinVersion` / `tlsMaxVersion` | `string` | TLS version bounds (`"1.0"`–`"1.3"`)                                                          |
| `httpVersion`                     | `string` | Force `"http1"` / `"http2"` instead of ALPN                                                   |
| `tlsOptions`                      | `object` | Raw ClientHello overrides — **diverges the fingerprint**, use sparingly                       |

## Request bodies

Everything reduces to a UTF-8 string or raw bytes before hitting the native
layer. When a body type has a canonical `Content-Type`, it's applied **only if
you didn't set one yourself**.

| You pass                                           | Sent as          | Default `Content-Type`                            |
| -------------------------------------------------- | ---------------- | ------------------------------------------------- |
| `string`                                           | the string       | none                                              |
| `Uint8Array` / `Buffer` / typed array / `DataView` | its exact bytes  | none                                              |
| `ArrayBuffer` / `SharedArrayBuffer`                | its bytes        | none                                              |
| `URLSearchParams`                                  | `key=val&…`      | `application/x-www-form-urlencoded;charset=UTF-8` |
| `Blob`                                             | the blob's bytes | the blob's `type`                                 |
| `FormData`                                         | —                | **throws** ([why](#why-no-formdata))              |
| `ReadableStream`                                   | —                | **throws** (no streaming upload)                  |
| `null` / `undefined`                               | no body          | none                                              |

```js
// bytes
await fetch(url, { method: 'PUT', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })

// form-encoded (Content-Type set for you)
await fetch(url, { method: 'POST', body: new URLSearchParams({ q: 'hello world' }) })

// your own Content-Type wins over the default
await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ a: 1 }),
})
```

A typed-array **view** sends only its own region, not the whole backing buffer:

```js
const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
await fetch(url, { method: 'POST', body: backing.subarray(2, 5) }) // sends 3,4,5
```

### Why no FormData

A real browser's multipart serialization — the `----WebKitFormBoundary…` token,
part ordering, per-part header casing — is itself fingerprintable. Emitting a
_generic_ multipart body would add a tell while you're trying to look like
Chrome, the same reason `tlsOptions` is opt-in. Until the serialization can be
matched to the impersonated browser, `FormData` throws rather than silently
diverge. If you need multipart now, serialize it yourself and pass the bytes
plus your own `Content-Type: multipart/form-data; boundary=…`.

## Request headers

`headers` accepts any WHATWG `HeadersInit`:

```js
await fetch(url, { headers: { 'x-a': '1' } }) // object
await fetch(url, {
  headers: [
    ['x-a', '1'],
    ['x-b', '2'],
  ],
}) // array of pairs
await fetch(url, { headers: new Headers({ 'x-a': '1' }) }) // Headers instance
```

Case-insensitive duplicate names are **combined** with `", "` the way
`Headers.get` reports them, so the native layer never sees an ambiguous repeated
header:

```js
// { 'x-id': 'one', 'X-Id': 'two' }  →  sent as  x-id: one, two
```

Your custom headers ride on top of the impersonated profile's own headers. A
custom `Content-Type` lands in the request in the same place whether you set it
explicitly or let a `URLSearchParams`/`Blob` body default it — verified against
`tls.peet.ws` to keep the header order consistent.

## Response (`FetchResponse`)

| Member          | Type                   | Notes                                                                                       |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `status`        | `number`               |                                                                                             |
| `statusText`    | `string`               | Canonical reason phrase from the `http` crate, not the literal wire bytes (HTTP/2 has none) |
| `ok`            | `boolean`              | `status` in `200..299`                                                                      |
| `url`           | `string`               | Final URL after redirects                                                                   |
| `redirected`    | `boolean`              | Final URL differs from requested                                                            |
| `bodyUsed`      | `boolean`              | `true` once any accessor ran (advisory — bodies are re-readable)                            |
| `headers`       | `Headers`              | WHATWG `Headers` (iterable, `forEach`, `getSetCookie`)                                      |
| `rawHeaders`    | `FetchHeaders`         | Native collection preserving the server's **original casing and order**                     |
| `text()`        | `Promise<string>`      | Lossy UTF-8 decode (invalid bytes → U+FFFD), like WHATWG                                    |
| `json()`        | `Promise<any>`         |                                                                                             |
| `bytes()`       | `Promise<Uint8Array>`  |                                                                                             |
| `blob()`        | `Promise<Blob>`        | Typed from the response `Content-Type`                                                      |
| `arrayBuffer()` | `Promise<ArrayBuffer>` | A real Web `ArrayBuffer`                                                                    |

Because the body is buffered in memory, accessors are **re-readable** — a real
WHATWG stream throws on the second read; here it works, so you rarely need
`clone()`:

```js
const res = await fetch(url)
const text = await res.text()
const data = await res.json() // fine — re-reads the buffered body
```

Use `rawHeaders` when the server's exact header casing/order matters (fingerprint
analysis); use `headers` for everything else.

## How it differs from native `fetch`

Same as native `fetch` — don't change your code:

- A non-2xx response **resolves** (it doesn't reject); branch on `res.ok`.
- `arrayBuffer()` returns an `ArrayBuffer`; `bytes()` returns a `Uint8Array`.
- `res.headers` is a WHATWG `Headers`.

Deliberately different — be aware:

- **Bodies are re-readable.** `bodyUsed` flips to `true` after the first read but
  a second read still succeeds (buffered). Code that relies on the WHATWG
  single-use throw won't get it.
- **`arrayBuffer()` is `ArrayBuffer`, not Node `Buffer`.** If you're migrating
  from an older build of this package that returned a `Buffer`, switch to
  `bytes()` (which gives a `Uint8Array`) or wrap: `Buffer.from(await res.bytes())`.
- **Redirects are always followed** (`wreq`'s default policy); there's no
  `redirect: 'manual' | 'error'` control.
- **`statusText`** is the canonical reason phrase, not the literal wire bytes.

Not supported (yet) — see [roadmap](#not-supported-yet):

- `init.signal` / `AbortSignal` — accepted but a **no-op**; use `timeoutMs`.
- `res.body` (streaming download), `res.clone()`, `res.formData()`, `res.type`.
- `FormData` and `ReadableStream` request bodies (both throw).
- Browser-context options: `credentials`, `mode`, `cache`, `integrity`,
  `referrer`, `keepalive` — ignored (there's no browser origin/cookie-store model
  here beyond `session`).

## Migration recipes

**From native `fetch` / `undici`** — mostly a drop-in, then add a fingerprint:

```js
// before
const res = await fetch('https://api.example.com/data', {
  headers: { authorization: `Bearer ${token}` },
})

// after — same call, now impersonating Chrome
const { fetch } = require('@trishchuk/fetch')
const res = await fetch('https://api.example.com/data', {
  headers: { authorization: `Bearer ${token}` },
  impersonate: 'chrome_147',
})
```

**A form POST behind a fingerprint check:**

```js
const res = await fetch('https://site.example/login', {
  method: 'POST',
  body: new URLSearchParams({ user, pass }),
  impersonate: 'chrome_147',
  session: 'user-42', // keep the cookie jar for subsequent calls
})
```

**Cancellation → timeout.** Replace `AbortController` with `timeoutMs` for now:

```js
// before: const ac = new AbortController(); setTimeout(() => ac.abort(), 5000)
//         fetch(url, { signal: ac.signal })
const res = await fetch(url, { timeoutMs: 5000 })
```

**Streaming download → buffered read with a cap.** There's no `res.body`;
read the whole body (bounded by `maxResponseBytes`):

```js
const res = await fetch(url, { maxResponseBytes: 64 * 1024 * 1024 })
const bytes = await res.bytes()
```

## Not supported yet

These are known gaps, roughly in priority order:

1. **Streaming response** (`res.body` as a `ReadableStream`) — the 32 MiB buffer
   cap is the main pain point for large scrapes. Needs to preserve an equivalent
   size/backpressure guard so an untrusted response can't exhaust the process.
2. **`AbortSignal`** with real cancellation — must be wired down into the native
   request future so the `wreq` request is actually dropped, not just the JS
   promise rejected (a cosmetic abort would leak the connection).
3. **`FormData`** with browser-exact multipart serialization.
4. **Streaming upload** (`ReadableStream` request body).

See the README's [Known limitations](../README.md#known-limitations) for the
full list, including the TCP/IP-fingerprint caveat that sits below any userspace
HTTP library.
