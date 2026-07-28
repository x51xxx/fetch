// Hand-authored types for the ergonomic wrapper in `index.js`. Native
// (fingerprint/transport) option semantics live in `binding.d.ts`, generated
// from the Rust doc comments; the shared option types are re-exported here.

import type {
  FetchHeaders,
  FetchOptions,
  ImpersonatePresetInfo,
  TlsOptionsOverride,
} from './binding'

export type { FetchHeaders, FetchOptions, ImpersonatePresetInfo, TlsOptionsOverride }

/** Anything the wrapper accepts as request headers. */
export type HeadersInit =
  Headers | Record<string, string> | Array<[string, string]> | Iterable<[string, string]>

/**
 * Anything the wrapper accepts as a request body. Higher-level shapes are
 * normalized to a string or bytes before reaching the native layer.
 * `FormData` and `ReadableStream` are intentionally rejected — see the README.
 */
export type BodyInit = string | Uint8Array | ArrayBuffer | ArrayBufferView | URLSearchParams | Blob

/** A `Request`-like input: the wrapper reads `url`/`method`/`headers` and buffers the body. */
export interface RequestLike {
  url: string
  method?: string
  headers?: HeadersInit
  bodyUsed?: boolean
  arrayBuffer?(): Promise<ArrayBuffer>
}

export type FetchInput = string | URL | RequestLike

export interface FetchInit {
  /** HTTP method. Standard method names are upper-cased (WHATWG rules). Defaults to `"GET"`. */
  method?: string
  /** Request headers as a `Headers`, an array of pairs, or a plain object. */
  headers?: HeadersInit
  /**
   * Request body. `string`, `Uint8Array`/`Buffer`, `ArrayBuffer`, typed
   * arrays/`DataView`, `URLSearchParams`, and `Blob` are supported;
   * `URLSearchParams`/`Blob` also set a default Content-Type if you didn't.
   */
  body?: BodyInit | null
  /**
   * Fingerprint to emulate: a native `wreq-util` profile (`"chrome_147"`), a
   * curl-impersonate preset (`"chrome116"` — see `listImpersonatePresets()`),
   * or `"random"` / `"weighted_random"`. Defaults to `"chrome_147"`.
   */
  impersonate?: string
  /** Declared OS for UA/client-hint headers: `"windows"`, `"macos"`, `"linux"`, `"android"`, `"ios"`. Does not diverge the TLS fingerprint. */
  platform?: string
  /** Per-request proxy URL (`http://`, `https://`, or `socks5://`, optional userinfo). */
  proxy?: string
  /**
   * Pin the initial request hostname to literal IPs without changing TLS SNI,
   * certificate validation, or the Host header. Keys are `"host"` or
   * `"host:port"`; a port-specific key wins. Redirects to another host are not
   * pinned, so SSRF-sensitive callers must use `redirect: "manual"` and re-pin
   * each validated hop. Ignored when `proxy` is set. With `session` set, the
   * pinned request shares that session's cookie jar.
   */
  resolve?: Record<string, string | string[]>
  /** WHATWG redirect handling. Defaults to `"follow"`. Also read from a `Request` input. */
  redirect?: 'follow' | 'manual' | 'error'
  /** Opaque session id; the cookie jar is keyed by it alone and shared by every call using it. */
  session?: string
  /** Overall request timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Maximum buffered response body size in bytes. Defaults to 32 MiB.
   *
   * With `stream: true` this is **unset by default** (no cap — not holding the
   * body in memory is the point); pass a value for an explicit cumulative cap.
   * Note the buffering accessors (`text()`/`json()`/…) always re-apply the
   * 32 MiB limit even on a streamed response, since they materialize the body.
   */
  maxResponseBytes?: number
  /**
   * Do not buffer the response body. `fetch()` resolves as soon as headers
   * arrive and `response.body` becomes a WHATWG `ReadableStream<Uint8Array>`,
   * so peak memory tracks the chunk size rather than the response size.
   *
   * Changes error timing: a mid-body failure rejects while reading the stream
   * instead of rejecting `fetch()`. That is why this is opt-in.
   */
  stream?: boolean
  /** Minimum TLS version to offer: `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`. Client-level. */
  tlsMinVersion?: string
  /** Maximum TLS version to offer. Client-level. */
  tlsMaxVersion?: string
  /** Force `"http1"` or `"http2"` instead of ALPN negotiation. Client-level. */
  httpVersion?: string
  /** Raw ClientHello overrides layered on `impersonate`. Diverges the fingerprint — use sparingly. Client-level. */
  tlsOptions?: TlsOptionsOverride
}

/**
 * A `fetch`-Response-shaped view over the native buffered response. Because the
 * body is fully buffered, accessors are re-readable (they don't throw on a
 * second call); `bodyUsed` reports whether at least one accessor has run.
 */
export declare class FetchResponse {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly url: string
  readonly redirected: boolean
  readonly bodyUsed: boolean
  /** WHATWG `Headers` (iterable, `forEach`, `getSetCookie`, case-insensitive). */
  readonly headers: Headers
  /** Native header collection preserving the server's original casing and order. */
  readonly rawHeaders: FetchHeaders
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  json(): Promise<any>
  blob(): Promise<Blob>
  /**
   * An independent view over the same response. Copies no payload — the body is
   * already buffered natively — only the wrapper, so each copy has its own
   * `bodyUsed` and `Headers`.
   *
   * Unlike WHATWG this does **not** throw when `bodyUsed` is true, because on
   * this path `bodyUsed` is advisory and the accessors are re-readable anyway.
   */
  clone(): FetchResponse
}

/**
 * Stable transport-failure categories carried on {@link FetchError.code}.
 *
 * `PROXY_CONNECT` (the connection to the proxy failed) vs `CONNECT` (the origin
 * connection failed) is the key distinction for proxy rotation. A request-time
 * TLS handshake or certificate failure is reported as `CONNECT` — there is no
 * separate `TLS` code (see the note below). `TIMEOUT` means `timeoutMs` elapsed
 * and is stage-agnostic: it does not by itself say whether the proxy or the
 * origin was at fault.
 */
export type FetchErrorCode =
  | 'PROXY_CONNECT'
  | 'TIMEOUT'
  | 'CONNECT'
  | 'CONNECTION_RESET'
  | 'REDIRECT'
  | 'DECODE'
  | 'BODY'
  | 'REQUEST'
  | 'REQUEST_FAILED'
  | 'RESPONSE_TOO_LARGE'

/**
 * Thrown when a request fails at the transport layer (connection, proxy,
 * timeout, or body). The originating native error is preserved on `cause`.
 * Option-validation failures reject with the native `Error`/`TypeError` instead
 * (not a `FetchError`), with `code: 'InvalidArg'`: a bad option, an invalid
 * `proxy` URL, or invalid `tlsOptions` (e.g. an unknown `cipherList`, rejected
 * with an "invalid tlsOptions: …" message).
 */
export declare class FetchError extends Error {
  readonly name: 'FetchError'
  readonly code: FetchErrorCode
  readonly cause?: unknown
}

/**
 * A `fetch`-Response-shaped view over a response whose body is still on the
 * wire, returned when `stream: true` is passed. Unlike {@link FetchResponse} the
 * body is genuinely one-shot: reading it twice throws, and `bodyUsed` is real.
 *
 * Peak memory tracks the chunk size, not the response size — a multi-GB body
 * never materializes. Measured: a 2 GiB download holds ~206 MiB RSS streamed vs
 * ~4.1 GiB buffered (`node bench/memory-large-file.mjs`).
 */
export declare class StreamingFetchResponse {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly url: string
  readonly redirected: boolean
  readonly bodyUsed: boolean
  readonly headers: Headers
  readonly rawHeaders: FetchHeaders
  /** `null` for 204/304 and for a body that was already taken. */
  readonly body: ReadableStream<Uint8Array> | null
  /**
   * Requests cancellation of the transfer and releases the connection.
   * Idempotent, and safe to call while a read is in flight.
   *
   * When a reader holds the stream this is **not** a resource-release barrier:
   * it fires the native cancellation token, which an in-flight `read()` observes
   * on its next poll and only then drops the body. Awaiting it means
   * cancellation was requested, not that the socket is already closed.
   */
  cancel(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  /** Buffering accessors — one-shot, and bounded by 32 MiB regardless of `maxResponseBytes`. */
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  json(): Promise<any>
  blob(): Promise<Blob>
  /**
   * Always throws `TypeError` on a streamed response. WHATWG defines `clone()`
   * as `tee()`, which buffers the slower branch without bound and would undo
   * the point of `stream: true`. Call `response.body.tee()` directly if you
   * accept that cost.
   */
  clone(): never
}

/**
 * WHATWG-shaped fetch with TLS/HTTP2 fingerprint control. Rejects with a
 * {@link FetchError} (carrying a `code`) on transport failure.
 *
 * With `stream: true` returns a {@link StreamingFetchResponse} instead, whose
 * body is a `ReadableStream`. The TLS/HTTP2 fingerprint is identical either way
 * (both paths share one request-building helper in `src/lib.rs`).
 */
export declare function fetch(
  input: FetchInput,
  init: FetchInit & { stream: true }
): Promise<StreamingFetchResponse>
export declare function fetch(input: FetchInput, init?: FetchInit): Promise<FetchResponse>

/** Lists every curl-impersonate preset name accepted by `impersonate`. */
export declare function listImpersonatePresets(): Array<ImpersonatePresetInfo>

/** Drops every cached client (and cookie jar) for a session. Returns the count removed. */
export declare function clearSession(session: string): number

/** Clears all cached clients (and their cookie jars). Returns the count removed. */
export declare function clearClientCache(): number
