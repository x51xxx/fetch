# Benchmark: native `fetch` vs `my-fetch`

k6-driven load test comparing Node's built-in `fetch` (undici) against this
project's `fetch()` (wreq/BoringSSL native addon), across concurrency,
throughput, and payload size, plus a cold real-HTTPS handshake probe.

Interactive version with charts: [`benchmark-report.html`](./benchmark-report.html).

## TL;DR

|                                                 | native fetch | my-fetch          |
| ----------------------------------------------- | ------------ | ----------------- |
| 2 MB payload @ 1000 req/s sustained — delivered | 636 req/s    | 999.9 req/s       |
| same run — error rate                           | 14.7%        | 0.00%             |
| same run — http p95                             | 1.77s        | 3.3ms             |
| 512B payload, 1 concurrent request              | 606 req/s    | 3252 req/s (5.4×) |
| cold real-HTTPS handshake, n=50, median         | 107.4ms      | 62.8ms (1.7×)     |

## Why a gateway, not k6 calling the library directly

k6 scripts run in [goja](https://github.com/dop251/goja), k6's own Go-based JS
engine — it cannot load Node's `fetch` (undici) or this project's native N-API
addon (`fetch.*.node`). Each client instead runs behind a tiny HTTP wrapper
("gateway"); k6 drives load against the wrapper, which forwards to a synthetic
upstream and reports its own outbound-call time via an `x-upstream-ms`
response header. This also mirrors how `my-fetch` is actually used in
production — server-side, behind a request handler — rather than as a
load-generator's own HTTP client.

```
k6 (load generator) → gateway (native fetch) → synthetic upstream
k6 (load generator) → gateway (my-fetch)      → synthetic upstream
```

Both gateways reuse one pooled connection to the upstream (verified: 20
sequential requests → 1 socket, for both clients), so the comparison isn't
skewed by connection setup. The native and wreq gateways run as **separate
processes**, and every scenario runs **sequentially, never concurrently** —
`my-fetch` does its I/O on Rust/tokio threads off the Node event loop, undici
runs mostly on it, and racing the two would have the asymmetric threading
models fight for the same cores instead of measuring the client. Upstream
response bodies are pre-allocated per size and cached, so the upstream itself
never becomes the confound.

## TLS is out of scope for the local matrix

`my-fetch`'s bundled BoringSSL root store does not trust a local self-signed
certificate — confirmed empirically with a generated CA plus `SSL_CERT_FILE`
and `SSL_CERT_DIR` set, both rejected with a `client error (Connect)`. So the
local k6 matrix runs over **plain HTTP** and structurally cannot include a TLS
handshake. `bench/cold-tls-probe.js` fills that gap separately (see below).

## Method

- **Load profiles** (`{name}:{delay_ms}:{size_bytes}` on the synthetic
  upstream): `fast_small` (0ms, 512B), `small_fast` (0ms, 4KB), `typical`
  (20ms, 4KB), `large_nodelay` (0ms, 256KB), `slow_large` (100ms, 64KB),
  `huge_body` (0ms, 2MB).
- **Concurrency sweep** (`constant-vus`, closed model): 1, 10, 50, 100, 250,
  500 VUs, 15s each. Bounded by how fast one request cycle completes — mostly
  measures per-call client overhead.
- **Throughput sweep** (`constant-arrival-rate`, open model): 50, 200, 500,
  1000, 2000 req/s, 15s each, with generous `preAllocatedVUs`/`maxVUs`
  headroom so k6 itself never starves for VUs on high-rate × high-delay
  combos. Load is offered independent of response speed — this is what
  reveals saturation.
- **Cold TLS probe**: 50 trials per client against `https://example.com/`,
  each trial spawning a brand-new Node process so connection pooling is
  structurally impossible — every request pays full DNS + TCP + TLS.
- 132 k6 runs total (6 profiles × 6 VUs × 2 clients + 6 profiles × 5 rates × 2
  clients), zero unexpected errors except where noted below.

Reproduce: `bash bench/run-matrix.sh` (set `QUICK=1` for a ~1min smoke pass
instead of the full ~35-40min matrix), then `node bench/cold-tls-probe.js
https://example.com/ 50`. Regenerate the HTML report with `node
bench/build-report-data.js` followed by splicing `bench/report-data.json`
into `bench/report-template.html` (see the inline `node -e` snippet in the
session, or write a small script — the placeholder is `__REPORT_DATA_JSON__`).

## Findings

### The headline: large-payload throughput collapse

At **2MB payload × 1000 req/s** sustained (~2GB/s offered through the
gateway):

|                    | native fetch | my-fetch  |
| ------------------ | ------------ | --------- |
| delivered req/s    | 636          | 999.9     |
| error rate         | 14.7%        | 0.00%     |
| http p95           | 1.77s        | 3.3ms     |
| dropped iterations | 2610         | 0         |
| actual throughput  | ~1.1 GB/s    | ~2.1 GB/s |

native fetch (undici) backpressures hard under sustained large-body load;
my-fetch delivers the full target rate with sub-4ms p95 and zero errors. At
2000 req/s (~4GB/s) both clients hit the local loopback/memory ceiling
(25-46% errors) — that's a system limit, not a client difference, and is
called out as such in the report rather than over-claimed.

### Concurrency sweep (1→500 VUs)

- **Small, fast payloads (512B-4KB, no backend delay):** my-fetch is 4-6×
  faster at low concurrency (3252 vs 606 req/s at 1 VU); the gap narrows to
  ~1.3× once the synthetic upstream itself saturates (~20-25k req/s ceiling).
- **Large payloads, no delay (256KB):** my-fetch stays ~2× ahead on
  throughput and has meaningfully better tail latency (p95 31ms vs 61ms at
  250 VUs).
- **huge_body (2MB) under concurrency:** my-fetch is 2-7× ahead on p95 (250
  VUs: 148ms vs 1069ms); native starts erroring at 500 VUs (2.02% vs 0.16%).
- **Backend-bound profiles (typical 20ms, slow_large 100ms delay):** clients
  converge to within 1-15% — network/backend latency dominates client
  overhead here, as expected.

### Throughput sweep (50→2000 req/s)

Same pattern as the concurrency sweep, plus the huge_body collapse detailed
above.

### Cold-connection TLS handshake (real HTTPS, n=50, no pooling)

```
native fetch : avg=107.9ms  min=102.1  median=107.4  p95=111.8  max=138.0
my-fetch     : avg=63.2ms   min=57.5   median=62.8   p95=69.1   max=83.4
```

Zero overlap across all 50 trials in either direction (native's fastest run
is still slower than my-fetch's slowest) — a clean, consistent ~1.7×
difference attributable to the handshake/connection path itself.

## Source files

| File                                                             | Purpose                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench/upstream-server.js`                                       | Synthetic HTTP upstream: configurable delay/size via query params, cached response bodies, connection/request counters at `/stats`.                   |
| `bench/gateway-server.js`                                        | Per-client wrapper (`CLIENT=native\|wreq` env var) that forwards to the upstream and times its own outbound call.                                     |
| `bench/k6-scenario.js`                                           | k6 scenario script, env-configurable executor (`constant-vus` / `constant-arrival-rate`), VUs/rate/duration/delay/size.                               |
| `bench/run-matrix.sh`                                            | Orchestrates upstream + both gateways, sweeps the full profile × concurrency/rate matrix sequentially, writes `bench/results/*.json` + `summary.csv`. |
| `bench/report.js`                                                | Parses `bench/results/*.json` into a console comparison table + `summary.csv`.                                                                        |
| `bench/cold-tls-probe.js` + `bench/probe-child-{native,wreq}.js` | Cold-connection real-HTTPS latency probe (fresh process per request).                                                                                 |
| `bench/build-report-data.js`                                     | Aggregates `summary.csv` + cold-probe output into `bench/report-data.json` for the HTML report.                                                       |
| `bench/report-template.html`                                     | HTML report template (charts via hand-rolled SVG, no external dependencies) — `__REPORT_DATA_JSON__` placeholder gets spliced with the built data.    |

`bench/results/` (raw k6 JSON exports, logs, `summary.csv`) is gitignored —
regenerate with `bash bench/run-matrix.sh`.
