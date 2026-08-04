'use strict'

// Hand-authored ergonomic wrapper over the NAPI-generated native binding
// (`./binding.js`, produced by `napi build --js binding.js --dts binding.d.ts`).
// It keeps the whole point of this package — TLS/HTTP2 fingerprint control —
// untouched, and closes the ergonomic gaps that made the raw native `fetch`
// awkward to use as a `fetch`: WHATWG-shaped `(input, init)` call signature,
// `URL`/`Request`/`Headers` inputs, binary / `URLSearchParams` / `Blob` /
// typed-array request bodies, `AbortSignal` (WHATWG semantics: rejection with
// the signal's own `reason`, an errored — not closed — body stream), and a
// Response with `.bytes()`/`.blob()` plus WHATWG `bodyUsed` semantics. It
// deliberately does NOT try to be undici: FormData/multipart and streaming
// request bodies are not handled here — see the README "Known limitations".

const binding = require('./binding.js')

const nativeFetch = binding.fetch
const nativeFetchStreaming = binding.fetchStreaming

// Cap re-applied when a *streamed* response is materialized via text()/json()/
// arrayBuffer()/bytes()/blob(). Those accessors buffer by definition, so without
// this a `stream: true` caller who then calls `.json()` would reintroduce exactly
// the unbounded allocation streaming exists to avoid. Mirrors
// DEFAULT_MAX_RESPONSE_BYTES in src/lib.rs.
const BUFFERED_ACCESSOR_LIMIT = 32 * 1024 * 1024

// WHATWG "null body status" list. Responses with these statuses have no body at
// all, so `response.body` is `null` rather than an empty stream.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

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

// The value an abort rejects with. WHATWG requires the signal's own `reason`,
// identity-preserved (a caller's `controller.abort(customError)` must come
// back as that exact object, and the reason may legitimately be a string or
// even `null`) — never a wrapper and never a new error with `cause`. A real
// `AbortSignal` always carries a reason once aborted, so the DOMException
// fallback only guards `abort(undefined)`-style edge cases.
function abortReason(signal) {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError')
}

// Safety net for a streamed response that is dropped without ever being read:
// its abort listener holds only a WeakRef to the response, and this registry
// removes the listener itself once the response is collected, so a long-lived
// signal (e.g. a process-wide shutdown controller) does not accumulate dead
// listeners. Deterministic removal happens on every terminal path (EOF, error,
// abort, cancel, null body) — this covers only abandonment.
const abortRegistry = new FinalizationRegistry(({ signal, listener }) => {
  signal.removeEventListener('abort', listener)
})

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
//
// `[ABORTED]` is a private marker, not a public code: it means the native
// transfer was torn down by `AbortHandle.abort()`, and per WHATWG the caller
// must see the signal's own `reason` — so it is swapped out here rather than
// becoming a `FetchError`.
function enrichNativeError(err, signal) {
  if (err instanceof Error && typeof err.message === 'string') {
    const match = TAGGED_ERROR.exec(err.message)
    if (match) {
      if (match[1] === 'ABORTED') {
        return signal
          ? abortReason(signal)
          : new DOMException('This operation was aborted', 'AbortError')
      }
      if (NATIVE_ERROR_CODES.has(match[1])) {
        return new FetchError(match[2], match[1], { cause: err })
      }
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

  // WebIDL member semantics: an explicitly-`undefined` `init.signal` counts as
  // absent (fall back to the Request's own signal), while an explicit `null`
  // disables an inherited signal. Anything present must be a real AbortSignal —
  // undici brand-checks too, and silently ignoring a mistyped signal would turn
  // "abort works" into "abort never fires".
  let signal = init.signal !== undefined ? init.signal : requestObj ? requestObj.signal : undefined
  if (signal != null && !(signal instanceof AbortSignal)) {
    throw new TypeError("Failed to execute 'fetch': member signal is not of type AbortSignal.")
  }
  if (signal == null) signal = undefined
  // Already aborted: reject before any work, with the signal's exact reason.
  if (signal && signal.aborted) throw abortReason(signal)

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
    // The `Blob.arrayBuffer()` inside normalization is not itself cancelable,
    // so an abort landing during it is observed here, right after — delayed by
    // an in-memory copy, not by any network wait.
    if (signal && signal.aborted) throw abortReason(signal)
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
    if (signal && signal.aborted) throw abortReason(signal)
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

  // Bridge the signal to the native layer: one `AbortHandle` per request whose
  // token the Rust side races against every await (connect/TLS/headers, and
  // each body chunk). Attached as late as possible — everything before this
  // point is covered by the plain `signal.aborted` checks above.
  let handle
  let onAbort
  if (signal) {
    handle = new binding.AbortHandle()
    const h = handle
    onAbort = () => h.abort()
    signal.addEventListener('abort', onAbort, { once: true })
  }

  if (init.stream === true) {
    // `maxResponseBytes` is forwarded untouched. Omitted means no cap on this
    // path (the native side reads `None` as unlimited), and an explicit 0 stays
    // 0 so it rejects the first non-empty chunk just like the buffered path --
    // it must not be quietly promoted to "unlimited".
    let nativeStream
    try {
      nativeStream = await nativeFetchStreaming(url, options, handle)
    } catch (err) {
      throw enrichNativeError(err, signal)
    } finally {
      // This listener only covered the native call; the response installs its
      // own below, because on the streaming path the signal keeps governing
      // the body long after `fetch()` has resolved.
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (signal && signal.aborted) {
      // The abort raced the headers and lost. WHATWG still rejects — the
      // caller aborted before `fetch()` settled. Release the connection first.
      nativeStream.takeBody()?.cancel()
      throw abortReason(signal)
    }
    // No await between the `aborted` check above and the constructor attaching
    // the response's own listener, so no abort can fall between the two.
    return new StreamingFetchResponse(nativeStream, method, signal ? { signal, handle } : undefined)
  }

  let native
  try {
    native = await nativeFetch(url, options, handle)
  } catch (err) {
    throw enrichNativeError(err, signal)
  } finally {
    // Buffered path: the transfer is fully over (body and all) once the native
    // promise settles, so the listener's job ends here either way.
    if (signal) signal.removeEventListener('abort', onAbort)
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

  /**
   * An independent view over the same response. The body is already buffered
   * natively, so this copies no payload at all — only the wrapper. Each copy
   * keeps its own `bodyUsed` and its own lazily-built `Headers`, so reading or
   * mutating one does not affect the other.
   *
   * Unlike WHATWG this does **not** throw when `bodyUsed` is true. On this path
   * `bodyUsed` is advisory and `text()` may be called repeatedly; refusing to
   * clone a response you can still re-read would be a stricter rule for the
   * weaker operation. See docs/fetch-compatibility.md.
   */
  clone() {
    return new FetchResponse(this.#native)
  }
}

/**
 * A `fetch`-Response-shaped view over a response whose body is still on the
 * wire. Unlike {@link FetchResponse}, the body is genuinely one-shot: peak
 * memory tracks the chunk size, not the response size, so a multi-GB download
 * never materializes.
 *
 * Error timing differs from the buffered path on purpose. `fetch()` here
 * resolves as soon as headers arrive, so a mid-body failure rejects while
 * reading the stream rather than from `fetch()` itself. That is why streaming is
 * opt-in.
 */
class StreamingFetchResponse {
  #native
  #headers
  #body // lazily-built WHATWG ReadableStream
  #bodyUsed = false
  #taken = false
  #nativeBody = null
  #method
  // AbortSignal wiring (all unset when the request carried no signal).
  #signal
  #handle
  #abortListener
  #aborted = false
  #abortReason
  #controller = null // the live ReadableStream controller, for erroring on abort
  #settled = false // terminal: the signal can no longer affect this response

  constructor(native, method, abortCtx) {
    this.#native = native
    this.#method = method
    if (abortCtx) {
      this.#signal = abortCtx.signal
      this.#handle = abortCtx.handle
      // The listener must not keep an abandoned response (and through it the
      // native body and its connection) alive for as long as the caller's
      // signal lives — hence the WeakRef, with `abortRegistry` reaping the
      // listener itself if the response is collected unread.
      const weakSelf = new WeakRef(this)
      this.#abortListener = () => {
        weakSelf.deref()?.#onAbort()
      }
      this.#signal.addEventListener('abort', this.#abortListener, { once: true })
      abortRegistry.register(this, { signal: this.#signal, listener: this.#abortListener }, this)
    }
  }

  // Terminal cleanup: after EOF, a body error, an abort, a cancel, or a
  // null-body response, the signal has nothing left to govern. Removing the
  // listener here (not just relying on `{ once: true }`) is what keeps a
  // never-aborted long-lived signal from pinning dead closures.
  #settle() {
    if (this.#settled) return
    this.#settled = true
    if (this.#signal) {
      this.#signal.removeEventListener('abort', this.#abortListener)
      abortRegistry.unregister(this)
    }
  }

  #onAbort() {
    if (this.#settled) return
    this.#aborted = true
    this.#abortReason = abortReason(this.#signal)
    // Unpark an in-flight native `read()` — it observes the fired token and
    // fails with the private `[ABORTED]` marker.
    this.#handle.abort()
    // WHATWG: an aborted response body *errors* with the signal's reason; it
    // must not close cleanly. Erroring an already-errored controller is a
    // spec-level no-op, so the race with a failing `pull()` is harmless.
    if (this.#controller) {
      this.#controller.error(this.#abortReason)
    }
    // With no read parked, nothing native is watching the token — drop the
    // stream directly so the connection is released now, not at finalization.
    if (this.#nativeBody) {
      this.#nativeBody.cancel()
    } else if (!this.#taken) {
      this.#taken = true
      this.#native.takeBody()?.cancel()
    }
    this.#settle()
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

  get headers() {
    if (this.#headers === undefined) {
      const headers = new Headers()
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

  get rawHeaders() {
    return this.#native.headers
  }

  /**
   * WHATWG `ReadableStream<Uint8Array>`, or `null` for a response that cannot
   * carry a body. Built once and cached, so `res.body === res.body`.
   */
  get body() {
    if (this.#body !== undefined) return this.#body
    // WHATWG null-body cases: the null-body status list, plus HEAD and CONNECT
    // responses (which never carry one regardless of status). Returning an empty
    // ReadableStream here instead would be observably wrong — `res.body` must be
    // `null`, and undici agrees.
    if (
      NULL_BODY_STATUS.has(this.status) ||
      this.#method === 'HEAD' ||
      this.#method === 'CONNECT'
    ) {
      // Release the native body rather than leaving it to the finalizer. For a
      // 204 or a HEAD there is nothing on the wire and this is a formality, but
      // a 101 or CONNECT can leave a live stream — and its socket — attached to
      // a response we are about to declare body-less.
      if (!this.#taken) {
        this.#taken = true
        this.#native.takeBody()?.cancel()
      }
      // A body that never existed cannot be aborted — release the listener.
      this.#settle()
      this.#body = null
      return null
    }

    if (this.#aborted) {
      // Aborted before anyone touched the body. WHATWG: the response body is
      // errored with the abort reason — not `null`, and not an empty stream.
      // The native side was already released in #onAbort().
      const reason = this.#abortReason
      this.#body = new ReadableStream({
        start(controller) {
          controller.error(reason)
        },
      })
      return this.#body
    }

    const nativeBody = this.#taken ? null : this.#native.takeBody()
    this.#taken = true
    if (nativeBody == null) {
      this.#body = null
      return null
    }
    // Held so `cancel()` can reach the native token even once the stream is
    // locked to a reader. The native side hands the body out exactly once, so
    // re-calling `takeBody()` later would return null and silently cancel
    // nothing -- which is precisely the case (a parked `read()`) where
    // cancellation matters most.
    this.#nativeBody = nativeBody

    const self = this
    const markUsed = () => {
      this.#bodyUsed = true
    }
    this.#body = new ReadableStream(
      {
        start(controller) {
          // Held on the response so #onAbort() can error the stream with the
          // signal's reason even while a reader has it locked.
          self.#controller = controller
        },
        // Pull-based: exactly one native read per `pull`, so the consumer
        // governs how far ahead we read. This is what makes backpressure reach
        // all the way to the TCP window.
        async pull(controller) {
          markUsed()
          let chunk
          try {
            chunk = await nativeBody.read()
          } catch (err) {
            self.#settle()
            // On abort the controller was already errored with the signal's
            // exact reason; `error()` on a non-readable stream is a no-op, so
            // this cannot clobber it with the translated native error.
            controller.error(
              self.#aborted ? self.#abortReason : enrichNativeError(err, self.#signal)
            )
            return
          }
          if (self.#aborted) {
            // The abort landed between the read settling and this microtask:
            // the controller is already errored, and `close()` would throw.
            return
          }
          if (chunk == null) {
            self.#settle()
            controller.close()
            return
          }
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        },
        cancel() {
          markUsed()
          // Consumer cancellation, not an abort: clean teardown, no error.
          self.#settle()
          nativeBody.cancel()
        },
      },
      // highWaterMark 0 is load bearing, not a tuning knob. At the default of 1
      // the stream speculatively calls `pull()` to fill its queue the moment it
      // is constructed, so merely touching `response.body` and yielding would
      // flip `bodyUsed` and make a later `text()` throw on a stream nobody read.
      // With 0 the source is fully lazy: `pull()` runs only for a real read, so
      // it is a truthful signal of consumption — and nothing is fetched ahead of
      // what the consumer asked for.
      { highWaterMark: 0 }
    )
    return this.#body
  }

  /**
   * Requests cancellation of the transfer and releases the connection.
   * Idempotent, and safe to call while a read is in flight.
   *
   * Note the promise is **not** a resource-release barrier when a reader holds
   * the stream: it fires the native cancellation token, which an in-flight
   * `read()` observes on its next poll and only then drops the body. Awaiting
   * this tells you cancellation was requested, not that the socket is already
   * closed. With no reader attached, the stream's own `cancel()` runs and the
   * body is dropped before the promise settles.
   */
  async cancel() {
    // Already torn down and errored by the signal; there is nothing left to
    // release, and "cancel after abort" must stay an abort, not soften into a
    // clean close.
    if (this.#aborted) return
    const body = this.body
    // Nothing to cancel, and nothing to disturb — `bodyUsed` stays false.
    if (body == null) return
    if (!body.locked) {
      await body.cancel() // routes through the source's cancel(), which marks used
    } else if (this.#nativeBody) {
      // Locked by an active reader, so the stream's cancel() is unreachable.
      // Fire the native CancellationToken directly: that is what unblocks a
      // `read()` already parked on the socket.
      this.#nativeBody.cancel()
      this.#bodyUsed = true
      this.#settle()
    }
  }

  async [Symbol.asyncDispose]() {
    await this.cancel()
  }

  // Buffering accessors. One-shot, WHATWG-style, and bounded — see
  // BUFFERED_ACCESSOR_LIMIT.
  async #consume() {
    if (this.#bodyUsed) throw new TypeError('Body is unusable: Body has already been read')
    const body = this.body
    if (body == null) {
      // A null body can never become disturbed, so per WHATWG `bodyUsed` stays
      // false and the accessors keep returning an empty body however many times
      // they are called. Marking it used here would make a second `text()` on a
      // 204 throw, which undici does not do.
      return Buffer.alloc(0)
    }
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > BUFFERED_ACCESSOR_LIMIT) {
          await reader.cancel()
          throw new FetchError(
            `buffered response body exceeds ${BUFFERED_ACCESSOR_LIMIT} bytes; read \`response.body\` as a stream instead`,
            'RESPONSE_TOO_LARGE'
          )
        }
        chunks.push(value)
      }
    } finally {
      this.#bodyUsed = true
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }

  async arrayBuffer() {
    const buf = await this.#consume()
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  async bytes() {
    const buf = await this.#consume()
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async text() {
    return (await this.#consume()).toString('utf-8')
  }

  async json() {
    return JSON.parse((await this.#consume()).toString('utf-8'))
  }

  async blob() {
    const buf = await this.#consume()
    return new Blob([buf], { type: this.#native.headers.get('content-type') || '' })
  }

  /**
   * Deliberately unsupported on a streamed response.
   *
   * WHATWG defines `clone()` in terms of `tee()`, and `tee()` buffers for the
   * slower branch without bound. A caller who reads one branch and ignores the
   * other would hold the entire body in memory — reintroducing exactly what
   * `stream: true` exists to prevent (measured: 206 MiB streamed vs 4.1 GiB
   * buffered on a 2 GiB body). It would also break backpressure, since the
   * `{ highWaterMark: 0 }` source stops being lazy once tee() drives it at the
   * faster branch's pace, and `maxResponseBytes` is a single cumulative counter
   * in Rust that does not split per branch.
   *
   * The primitive is still available and self-documenting: call
   * `response.body.tee()` directly if you accept that cost.
   */
  clone() {
    throw new TypeError(
      'clone() is not supported on a streamed response: teeing a stream buffers the ' +
        'slower branch without bound, which defeats the point of `stream: true`. ' +
        'Use `response.body.tee()` explicitly if you accept that cost.'
    )
  }
}

module.exports = {
  fetch,
  FetchResponse,
  StreamingFetchResponse,
  FetchError,
  FetchHeaders: binding.FetchHeaders,
  listImpersonatePresets: binding.listImpersonatePresets,
  clearSession: binding.clearSession,
  clearClientCache: binding.clearClientCache,
}
