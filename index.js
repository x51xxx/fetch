'use strict'

// Hand-authored ergonomic wrapper over the NAPI-generated native binding
// (`./binding.js`, produced by `napi build --js binding.js --dts binding.d.ts`).
// It keeps the whole point of this package — TLS/HTTP2 fingerprint control —
// untouched, and closes the ergonomic gaps that made the raw native `fetch`
// awkward to use as a `fetch`: WHATWG-shaped `(input, init)` call signature,
// `URL`/`Request`/`Headers` inputs, binary / `URLSearchParams` / `Blob` /
// typed-array request bodies, and a Response with `.bytes()`/`.blob()` plus
// WHATWG `bodyUsed` semantics. It deliberately does NOT try to be undici:
// FormData/multipart and streaming (both directions) and AbortSignal are not
// handled here — see the README "Known limitations".

const binding = require('./binding.js')

const nativeFetch = binding.fetch

// WHATWG normalizes exactly this set of method names to upper case and leaves
// any other (custom) method untouched.
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])

// Native FetchOptions fields that are NOT part of the WHATWG surface and are
// simply forwarded (the fingerprint/transport knobs).
const PASSTHROUGH_KEYS = [
  'impersonate',
  'platform',
  'proxy',
  'resolve',
  'redirect',
  'session',
  'timeoutMs',
  'maxResponseBytes',
  'tlsMinVersion',
  'tlsMaxVersion',
  'httpVersion',
  'tlsOptions',
]

// Stable transport-failure codes the native layer tags onto its error message
// as a `[CODE] ` prefix (see `classify_request_error` in src/lib.rs). Kept in
// sync with that Rust function — the wrapper trusts a leading tag only when the
// code is one of these, so a server error message that merely happens to start
// with bracketed upper-case text is never mistaken for a code.
const NATIVE_ERROR_CODES = new Set([
  'PROXY_CONNECT',
  'TIMEOUT',
  'CONNECT',
  'CONNECTION_RESET',
  'REDIRECT',
  'DECODE',
  'BODY',
  'REQUEST',
  'REQUEST_FAILED',
  'RESPONSE_TOO_LARGE',
])

const TAGGED_ERROR = /^\[([A-Z_]+)\] ([\s\S]*)$/

/**
 * Error thrown when a request fails at the transport layer (connection, proxy,
 * TLS, timeout, body). `code` is one of {@link NATIVE_ERROR_CODES}; the raw
 * native error is kept on `cause`. Argument-validation problems (a bad option,
 * an invalid proxy URL) still throw the native `Error`/`TypeError` unchanged.
 */
class FetchError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'FetchError'
    this.code = code
  }
}

// Turn a native transport error carrying a `[CODE] ` message tag into a
// `FetchError` with that code lifted out and the tag stripped from the message.
// Anything without a recognized tag (e.g. an `InvalidArg` from bad options) is
// passed through untouched so its own `.code` and type survive.
function enrichNativeError(err) {
  if (err instanceof Error && typeof err.message === 'string') {
    const match = TAGGED_ERROR.exec(err.message)
    if (match && NATIVE_ERROR_CODES.has(match[1])) {
      return new FetchError(match[2], match[1], { cause: err })
    }
  }
  return err
}

// `resolve` (client-side IP pinning) has no effect once a `proxy` is set,
// because the proxy resolves the origin hostname. That is documented, but was
// silently dropped at runtime; warn once per process so the contradiction is
// visible without spamming a hot path. A hard error was considered and rejected
// (see CHANGELOG) — a caller that always passes `resolve` and only sometimes a
// `proxy` is a legitimate pattern that must not break.
let resolveIgnoredWarned = false
function warnResolveIgnored() {
  if (resolveIgnoredWarned) return
  resolveIgnoredWarned = true
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(
      '`resolve` is ignored when `proxy` is set: the proxy, not this client, resolves the origin hostname.',
      { code: 'MYFETCH_RESOLVE_IGNORED' }
    )
  }
}

function normalizeMethod(method) {
  if (method == null) return undefined
  const upper = String(method).toUpperCase()
  return NORMALIZED_METHODS.has(upper) ? upper : String(method)
}

// Fold any HeadersInit (a `Headers`/`Map` instance, an array of `[name, value]`
// pairs, or a plain object) into the plain `Record<string,string>` the native
// layer wants. The native layer rejects case-only duplicate names, so combine
// same-named headers with ", " (matching `Headers.get`) before they get there.
function normalizeHeaders(input) {
  if (input == null) return undefined
  const out = []
  const add = (rawName, rawValue) => {
    const name = String(rawName)
    const lower = name.toLowerCase()
    const value = String(rawValue)
    const existing = out.find((entry) => entry.lower === lower)
    if (existing) {
      existing.value += `, ${value}`
    } else {
      out.push({ name, lower, value })
    }
  }
  if (typeof input.forEach === 'function' && !Array.isArray(input)) {
    // Headers / Map: forEach(value, name)
    input.forEach((value, name) => add(name, value))
  } else if (Array.isArray(input) || typeof input[Symbol.iterator] === 'function') {
    for (const pair of input) add(pair[0], pair[1])
  } else {
    for (const name of Object.keys(input)) add(name, input[name])
  }
  if (out.length === 0) return undefined
  const record = {}
  for (const entry of out) record[entry.name] = entry.value
  return record
}

// Reduce any BodyInit the wrapper accepts to what the native layer takes:
// a UTF-8 `string` or raw bytes (`Uint8Array`). Returns the value plus, when
// the body type implies one, a default Content-Type the caller applies only
// if the user didn't set their own (WHATWG's automatic-Content-Type rule).
async function normalizeBody(body) {
  if (body == null) return { body: undefined }
  if (typeof body === 'string') return { body }

  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    }
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer())
    return { body: bytes, contentType: body.type || undefined }
  }
  if (body instanceof ArrayBuffer) {
    return { body: new Uint8Array(body) }
  }
  if (typeof SharedArrayBuffer !== 'undefined' && body instanceof SharedArrayBuffer) {
    return { body: new Uint8Array(body) }
  }
  if (ArrayBuffer.isView(body)) {
    // TypedArray / DataView / Node Buffer — pass a view over the exact region.
    return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) }
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new TypeError(
      'FormData/multipart request bodies are not supported: a generic multipart ' +
        'serialization (boundary, part order, header casing) would diverge the ' +
        'impersonated browser fingerprint. Serialize it yourself and pass a string ' +
        'or Uint8Array.'
    )
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new TypeError('ReadableStream request bodies (streaming upload) are not supported yet.')
  }
  throw new TypeError(`Unsupported request body type: ${Object.prototype.toString.call(body)}`)
}

function isRequestLike(input) {
  return (
    input != null &&
    typeof input === 'object' &&
    typeof input.url === 'string' &&
    !(typeof URL !== 'undefined' && input instanceof URL)
  )
}

/**
 * WHATWG-shaped fetch. `input` is a URL string, a `URL`, or a `Request`-like
 * object; `init` is the option bag (WHATWG fields plus this package's
 * fingerprint/transport options). Returns a {@link FetchResponse}.
 */
async function fetch(input, init) {
  init = init || {}

  let url
  let requestObj = null
  if (typeof input === 'string') {
    url = input
  } else if (typeof URL !== 'undefined' && input instanceof URL) {
    url = input.href
  } else if (isRequestLike(input)) {
    url = input.url
    requestObj = input
  } else {
    url = String(input)
  }

  const method = normalizeMethod(
    init.method != null ? init.method : requestObj && requestObj.method
  )

  const headerSource =
    'headers' in init && init.headers != null ? init.headers : requestObj && requestObj.headers
  const headers = normalizeHeaders(headerSource)

  let bodyValue
  let defaultContentType
  if ('body' in init) {
    const normalized = await normalizeBody(init.body)
    bodyValue = normalized.body
    defaultContentType = normalized.contentType
  } else if (
    requestObj &&
    typeof requestObj.arrayBuffer === 'function' &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== undefined
  ) {
    // WHATWG: reusing a `Request` whose body was already read is a TypeError.
    // Only reachable when `init.body` was not given -- an explicit body takes
    // the branch above and legitimately ignores the Request's own body, so it
    // must not throw here. `bodyUsed` is only true for a non-null body that has
    // been read, so a bodyless POST does not trip this.
    if (requestObj.bodyUsed === true) {
      throw new TypeError(
        'Cannot construct a Request with a Request object whose body has already been used.'
      )
    }
    // A `Request` carried a body (its `.body` is a stream) — buffer it.
    const buffered = await requestObj.arrayBuffer()
    if (buffered && buffered.byteLength > 0) bodyValue = new Uint8Array(buffered)
  }

  let finalHeaders = headers
  if (defaultContentType) {
    finalHeaders = headers ? { ...headers } : {}
    const alreadySet = Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type')
    if (!alreadySet) finalHeaders['content-type'] = defaultContentType
  }

  const options = {}
  for (const key of PASSTHROUGH_KEYS) {
    if (init[key] !== undefined) options[key] = init[key]
  }
  // WHATWG: a `Request` carries its own `redirect` mode; init takes precedence.
  if (options.redirect === undefined && requestObj && typeof requestObj.redirect === 'string') {
    options.redirect = requestObj.redirect
  }
  if (method !== undefined) options.method = method
  if (finalHeaders !== undefined) options.headers = finalHeaders
  if (bodyValue !== undefined) options.body = bodyValue

  if (options.proxy !== undefined && options.resolve !== undefined) {
    warnResolveIgnored()
  }

  let native
  try {
    native = await nativeFetch(url, options)
  } catch (err) {
    throw enrichNativeError(err)
  }
  return new FetchResponse(native)
}

/**
 * A `fetch`-Response-shaped view over the native buffered response. Because the
 * body is fully buffered, accessors are re-readable (unlike a WHATWG stream,
 * they don't throw on a second call); `bodyUsed` reports whether at least one
 * accessor has run.
 */
class FetchResponse {
  #native
  #bodyUsed = false
  #headers

  constructor(native) {
    this.#native = native
  }

  get status() {
    return this.#native.status
  }

  get statusText() {
    return this.#native.statusText
  }

  get ok() {
    return this.#native.ok
  }

  get url() {
    return this.#native.url
  }

  get redirected() {
    return this.#native.redirected
  }

  get bodyUsed() {
    return this.#bodyUsed
  }

  // WHATWG `Headers` (iterable, `forEach`, `getSetCookie`, case-insensitive).
  get headers() {
    if (this.#headers === undefined) {
      const headers = new Headers()
      // `Headers` validates names/values more strictly than hyper does on
      // ingress, so a technically-invalid header from a hostile/quirky server
      // would otherwise make this getter throw. Skip such entries here (they
      // remain available verbatim via `rawHeaders`) rather than lose the whole
      // response's headers to one bad line.
      for (const [name, value] of this.#native.headers.entries()) {
        try {
          headers.append(name, value)
        } catch {
          /* preserved in rawHeaders */
        }
      }
      this.#headers = headers
    }
    return this.#headers
  }

  // The native header collection, preserving the server's original casing and
  // order — kept because that ordering can itself matter to fingerprint work,
  // and WHATWG `Headers` lower-cases and sorts it away.
  get rawHeaders() {
    return this.#native.headers
  }

  async #consume() {
    this.#bodyUsed = true
    return this.#native.arrayBuffer()
  }

  async arrayBuffer() {
    const buf = await this.#consume()
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  async bytes() {
    const buf = await this.#consume()
    // Viewing rather than copying is only safe because the native side hands
    // back a freshly-cloned, standalone Buffer per call (`FetchResponse::
    // array_buffer` in src/lib.rs), so this aliases neither the response's
    // internal body nor Node's shared Buffer pool. If that clone ever becomes
    // zero-copy, this has to go back to copying.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async text() {
    const buf = await this.#consume()
    return buf.toString('utf-8')
  }

  async json() {
    const buf = await this.#consume()
    return JSON.parse(buf.toString('utf-8'))
  }

  async blob() {
    const buf = await this.#consume()
    const type = this.#native.headers.get('content-type') || ''
    return new Blob([buf], { type })
  }
}

module.exports = {
  fetch,
  FetchResponse,
  FetchError,
  FetchHeaders: binding.FetchHeaders,
  listImpersonatePresets: binding.listImpersonatePresets,
  clearSession: binding.clearSession,
  clearClientCache: binding.clearClientCache,
}
