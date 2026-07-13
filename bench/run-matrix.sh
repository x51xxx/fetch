#!/usr/bin/env bash
# Orchestrates the native-fetch vs my-fetch benchmark matrix through k6.
#
# Architecture: k6 (goja) cannot load Node's fetch or our napi addon directly,
# so each client library runs behind its own tiny HTTP "gateway" wrapper that
# forwards to a synthetic upstream. k6 drives load against each gateway in
# turn and we compare the client-only leg via the x-upstream-ms header the
# gateway attaches (isolates client overhead from proxy/network overhead).
#
# Runs native and wreq sequentially (never concurrently) to avoid the two
# clients' asymmetric threading models (undici mostly on the event loop vs
# wreq's tokio threads) contending for the same cores and biasing results.
set -euo pipefail
cd "$(dirname "$0")/.."

RESULTS_DIR="bench/results"
mkdir -p "$RESULTS_DIR"
rm -f "$RESULTS_DIR"/*.json

UPSTREAM_PORT=9301
GATEWAY_NATIVE_PORT=9401
GATEWAY_WREQ_PORT=9402
UPSTREAM_URL="http://127.0.0.1:${UPSTREAM_PORT}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "== starting upstream and gateways =="
node bench/upstream-server.js >bench/results/upstream.log 2>&1 &
PIDS+=($!)
PORT=$GATEWAY_NATIVE_PORT CLIENT=native UPSTREAM_URL=$UPSTREAM_URL node bench/gateway-server.js >bench/results/gateway-native.log 2>&1 &
PIDS+=($!)
PORT=$GATEWAY_WREQ_PORT CLIENT=wreq UPSTREAM_URL=$UPSTREAM_URL node bench/gateway-server.js >bench/results/gateway-wreq.log 2>&1 &
PIDS+=($!)
sleep 1

for url in "http://127.0.0.1:${GATEWAY_NATIVE_PORT}/health" "http://127.0.0.1:${GATEWAY_WREQ_PORT}/health"; do
  curl -sf "$url" >/dev/null || { echo "gateway at $url failed to start" >&2; exit 1; }
done

# --- Matrix axes ---
# "load profile": upstream simulated latency + response size, in ms/bytes
LOAD_PROFILES=(
  "fast_small:0:512"
  "small_fast:0:4096"
  "typical:20:4096"
  "large_nodelay:0:262144"
  "slow_large:100:65536"
  "huge_body:0:2097152"
)

# concurrency sweep (closed model: fixed number of VUs, unbounded rate)
# throughput sweep (open model: fixed arrival rate, reveals saturation point)
if [ -n "${QUICK:-}" ]; then
  VUS_LEVELS=(1 20)
  RATE_LEVELS=(50)
  LOAD_PROFILES=("typical:20:4096")
else
  VUS_LEVELS=(1 10 50 100 250 500)
  RATE_LEVELS=(50 200 500 1000 2000)
fi

DURATION="${DURATION:-15s}"

run_k6() {
  local client_label=$1 target_url=$2 executor=$3 delay=$4 size=$5 concurrency_param=$6 out_name=$7
  echo "-- $client_label executor=$executor delay=${delay}ms size=${size}B param=$concurrency_param --"
  # Generous headroom for constant-arrival-rate so k6 never starves for VUs
  # on high-rate x high-delay combos (dropped iterations would corrupt results).
  local prealloc=$(( concurrency_param > 100 ? concurrency_param : 100 ))
  local maxvus=$(( prealloc * 3 ))
  TARGET_URL="$target_url" EXECUTOR="$executor" DELAY="$delay" SIZE="$size" DURATION="$DURATION" \
    VUS="$([ "$executor" = "constant-vus" ] && echo "$concurrency_param" || echo 10)" \
    RATE="$([ "$executor" = "constant-arrival-rate" ] && echo "$concurrency_param" || echo 50)" \
    PRE_ALLOCATED_VUS="$prealloc" MAX_VUS="$maxvus" \
    k6 run --summary-export "${RESULTS_DIR}/${out_name}.json" bench/k6-scenario.js \
    >"${RESULTS_DIR}/${out_name}.log" 2>&1 || echo "   (k6 run for ${out_name} exited non-zero, see log)"
}

echo "== concurrency sweep (constant-vus) =="
for profile in "${LOAD_PROFILES[@]}"; do
  IFS=':' read -r name delay size <<<"$profile"
  for vus in "${VUS_LEVELS[@]}"; do
    curl -s "${UPSTREAM_URL}/reset" >/dev/null
    run_k6 "native" "http://127.0.0.1:${GATEWAY_NATIVE_PORT}" "constant-vus" "$delay" "$size" "$vus" "vus_${name}_vus${vus}_native"
    curl -s "${UPSTREAM_URL}/reset" >/dev/null
    run_k6 "wreq" "http://127.0.0.1:${GATEWAY_WREQ_PORT}" "constant-vus" "$delay" "$size" "$vus" "vus_${name}_vus${vus}_wreq"
  done
done

echo "== throughput sweep (constant-arrival-rate) =="
for profile in "${LOAD_PROFILES[@]}"; do
  IFS=':' read -r name delay size <<<"$profile"
  for rate in "${RATE_LEVELS[@]}"; do
    curl -s "${UPSTREAM_URL}/reset" >/dev/null
    run_k6 "native" "http://127.0.0.1:${GATEWAY_NATIVE_PORT}" "constant-arrival-rate" "$delay" "$size" "$rate" "rate_${name}_rate${rate}_native"
    curl -s "${UPSTREAM_URL}/reset" >/dev/null
    run_k6 "wreq" "http://127.0.0.1:${GATEWAY_WREQ_PORT}" "constant-arrival-rate" "$delay" "$size" "$rate" "rate_${name}_rate${rate}_wreq"
  done
done

echo "== done, generating report =="
node bench/report.js
