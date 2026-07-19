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
  /** Maximum buffered response body size in bytes. Defaults to 32 MiB. */
  maxResponseBytes?: number
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
}

/** WHATWG-shaped fetch with TLS/HTTP2 fingerprint control. */
export declare function fetch(input: FetchInput, init?: FetchInit): Promise<FetchResponse>

/** Lists every curl-impersonate preset name accepted by `impersonate`. */
export declare function listImpersonatePresets(): Array<ImpersonatePresetInfo>

/** Drops every cached client (and cookie jar) for a session. Returns the count removed. */
export declare function clearSession(session: string): number

/** Clears all cached clients (and their cookie jars). Returns the count removed. */
export declare function clearClientCache(): number
