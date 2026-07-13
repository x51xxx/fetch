// Measures cold-connection (fresh TCP+TLS handshake, no pooling) request
// latency for native fetch vs my-fetch against a real HTTPS endpoint.
// Each trial spawns a brand-new Node process per request so connection
// pooling is structurally impossible -- this is what the local k6 matrix
// (bench/run-matrix.sh) cannot measure, since my-fetch's bundled BoringSSL
// root store won't trust a local self-signed cert (see README/session notes).
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const URL = process.argv[2] || 'https://example.com/'
const N = Number(process.argv[3] || 15)

function runChild(script) {
  const out = execFileSync('node', [script, URL], { encoding: 'utf8', timeout: 15000 })
  return JSON.parse(out.trim())
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  return {
    n: sorted.length,
    avg: sum / sorted.length,
    min: sorted[0],
    median: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1],
  }
}

async function main() {
  console.log(
    `Cold-connection probe against ${URL}, ${N} trials per client (alternating, fresh process per request)\n`
  )
  const nativeTimes = []
  const wreqTimes = []
  const nativeErrors = []
  const wreqErrors = []

  for (let i = 0; i < N; i++) {
    const n = runChild(path.join(__dirname, 'probe-child-native.js'))
    if (n.ok) nativeTimes.push(n.elapsed)
    else nativeErrors.push(n.error)

    const w = runChild(path.join(__dirname, 'probe-child-wreq.js'))
    if (w.ok) wreqTimes.push(w.elapsed)
    else wreqErrors.push(w.error)

    process.stdout.write(
      `  trial ${i + 1}/${N}: native=${n.ok ? n.elapsed.toFixed(1) + 'ms' : 'ERR'}  wreq=${w.ok ? w.elapsed.toFixed(1) + 'ms' : 'ERR'}\n`
    )
  }

  console.log('\n--- results (ms, includes DNS+TCP+TLS handshake, no pooling) ---')
  if (nativeTimes.length) {
    const s = stats(nativeTimes)
    console.log(
      `native fetch : n=${s.n} avg=${s.avg.toFixed(1)} min=${s.min.toFixed(1)} median=${s.median.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`
    )
  }
  if (wreqTimes.length) {
    const s = stats(wreqTimes)
    console.log(
      `my-fetch     : n=${s.n} avg=${s.avg.toFixed(1)} min=${s.min.toFixed(1)} median=${s.median.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`
    )
  }
  if (nativeErrors.length)
    console.log(`native errors (${nativeErrors.length}):`, [...new Set(nativeErrors)])
  if (wreqErrors.length)
    console.log(`wreq errors (${wreqErrors.length}):`, [...new Set(wreqErrors)])
}

main()
