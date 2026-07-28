[← Back to README](../README.md)

# Benchmark: Native `fetch` vs `@trishchuk/fetch`

A k6-driven load testing benchmark comparing Node's built-in `fetch` (`undici`) against `@trishchuk/fetch` (`wreq`/BoringSSL native addon) across varying concurrency, throughput, and payload sizes, alongside a cold HTTPS handshake probe.

> [!TIP]
> An interactive HTML report with charts is available at [`benchmark-report.html`](./benchmark-report.html).

---

## TL;DR Performance Summary

| Benchmark Metric                                                | Native `fetch` (`undici`) | `@trishchuk/fetch` | Relative Difference           |
| :-------------------------------------------------------------- | :------------------------ | :----------------- | :---------------------------- |
| **2 MB Payload @ 1,000 req/s Sustained** — Delivered Throughput | 636 req/s                 | **999.9 req/s**    | Delivered 100% of target rate |
| **2 MB Payload @ 1,000 req/s Sustained** — Error Rate           | 14.7%                     | **0.00%**          | Zero error dropouts           |
| **2 MB Payload @ 1,000 req/s Sustained** — HTTP p95 Latency     | 1.77 s                    | **3.3 ms**         | **536× lower p95 latency**    |
| **512 B Payload, 1 Concurrent Request** — Throughput            | 606 req/s                 | **3,252 req/s**    | **5.4× faster**               |
| **Cold HTTPS Handshake** (n=50, median latency)                 | 107.4 ms                  | **62.8 ms**        | **1.7× faster setup**         |

---

## Benchmark Architecture & Gateway Model

k6 scripts execute within [goja](https://github.com/dop251/goja) (k6's Go-based JavaScript engine) which cannot load Node's native `undici` module or NAPI native binary addons directly.

To benchmark both clients realistically, each client runs inside a lightweight HTTP gateway wrapper. k6 issues requests to the gateway, which forwards them to a synthetic upstream server and reports outbound execution metrics via custom response headers (`x-upstream-ms`).

```
k6 (Load Generator) ──► Gateway Wrapper (Native fetch) ──► Synthetic Upstream
k6 (Load Generator) ──► Gateway Wrapper (my-fetch)     ──► Synthetic Upstream
```

### Isolation & Execution Details

- Both gateways maintain a single pooled connection to the upstream server (verified: 20 sequential requests reuse 1 socket).
- Native and wreq gateways execute in separate processes.
- Scenarios run **sequentially** to prevent CPU thread contention (`my-fetch` uses Rust/tokio worker threads; `undici` runs on Node's main event loop).
- Upstream response bodies are pre-allocated and cached in memory.

---

## Test Scenarios & Methodology

- **Load Profiles** (`{name}:{delay_ms}:{size_bytes}` on upstream):
  - `fast_small`: 0 ms, 512 B
  - `small_fast`: 0 ms, 4 KB
  - `typical`: 20 ms, 4 KB
  - `large_nodelay`: 0 ms, 256 KB
  - `slow_large`: 100 ms, 64 KB
  - `huge_body`: 0 ms, 2 MB
- **Concurrency Sweep** (`constant-vus` closed model): 1, 10, 50, 100, 250, 500 VUs (15s each). Measures per-call client overhead.
- **Throughput Sweep** (`constant-arrival-rate` open model): 50, 200, 500, 1,000, 2,000 req/s (15s each). Load is offered independently of response speed to expose saturation boundaries.
- **Cold TLS Probe**: 50 trials against `https://example.com/` spawning fresh Node processes per request (pays full DNS + TCP + TLS handshake).

To reproduce benchmarks locally:

```bash
# Run matrix (set QUICK=1 for ~1min smoke test instead of full 35min suite)
bash bench/run-matrix.sh

# Run cold TLS probe
node bench/cold-tls-probe.js https://example.com/ 50
```

---

## Key Findings

### 1. Large Payload Throughput Collapse

At **2 MB payload × 1,000 req/s sustained** (~2 GB/s offered load):

| Metric               | Native `fetch` (`undici`) | `@trishchuk/fetch` |
| :------------------- | :------------------------ | :----------------- |
| Delivered req/s      | 636 req/s                 | **999.9 req/s**    |
| Error Rate           | 14.7%                     | **0.00%**          |
| HTTP p95 Latency     | 1.77 s                    | **3.3 ms**         |
| Dropped Iterations   | 2,610                     | **0**              |
| Effective Throughput | ~1.1 GB/s                 | **~2.1 GB/s**      |

> [!IMPORTANT]
> Native `fetch` (`undici`) experiences severe backpressure under sustained large-body throughput, whereas `@trishchuk/fetch` maintains zero errors with sub-4ms p95 latency.

### 2. Concurrency Performance (1 → 500 VUs)

- **Small Payloads (512 B – 4 KB)**: `@trishchuk/fetch` delivers 4–6× higher throughput at low concurrency (3,252 vs 606 req/s at 1 VU).
- **Large Payloads (256 KB)**: `@trishchuk/fetch` achieves 2× throughput with lower tail latency (p95 31 ms vs 61 ms at 250 VUs).
- **Backend-Bound Workloads**: When network delay dominates (20 ms / 100 ms), performance converges within 1–15% across clients.

### 3. Cold TLS Handshake Latency

```
native fetch : avg=107.9ms  min=102.1  median=107.4  p95=111.8  max=138.0
my-fetch     : avg=63.2ms   min=57.5   median=62.8   p95=69.1   max=83.4
```

> [!NOTE]
> `@trishchuk/fetch` demonstrates a consistent ~1.7× speedup on cold connection establishment due to BoringSSL and `wreq`'s direct native TLS handshake pipeline.

---

## Source Directory Overview

| File                                                          | Purpose                                                                |
| :------------------------------------------------------------ | :--------------------------------------------------------------------- |
| [`bench/upstream-server.js`](../bench/upstream-server.js)     | Synthetic HTTP upstream server with configurable delay and body sizes. |
| [`bench/gateway-server.js`](../bench/gateway-server.js)       | Per-client HTTP gateway wrapper (`CLIENT=native\|wreq`).               |
| [`bench/k6-scenario.js`](../bench/k6-scenario.js)             | k6 load testing scenario suite.                                        |
| [`bench/run-matrix.sh`](../bench/run-matrix.sh)               | Test orchestrator sweeping profile × concurrency × throughput.         |
| [`bench/report.js`](../bench/report.js)                       | Results parser producing console tables and `summary.csv`.             |
| [`bench/cold-tls-probe.js`](../bench/cold-tls-probe.js)       | Cold connection latency probe.                                         |
| [`bench/build-report-data.js`](../bench/build-report-data.js) | Aggregates JSON results for the HTML report.                           |
| [`bench/report-template.html`](../bench/report-template.html) | Standalone interactive HTML report template.                           |
