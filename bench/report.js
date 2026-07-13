const fs = require('node:fs')
const path = require('node:path')

const RESULTS_DIR = path.join(__dirname, 'results')

function loadResults() {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'))
  const rows = []
  for (const file of files) {
    const m = file.match(/^(vus|rate)_([a-z_]+)_(vus|rate)(\d+)_(native|wreq)\.json$/)
    if (!m) continue
    const [, sweep, profile, , param, client] = m
    let data
    try {
      data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'))
    } catch {
      continue
    }
    const metrics = data.metrics || {}
    const dur = metrics['http_req_duration'] || {}
    const upstream = metrics['upstream_ms'] || {}
    const reqs = metrics['http_reqs'] || {}
    const failed = metrics['http_req_failed'] || {}
    rows.push({
      sweep,
      profile,
      param: Number(param),
      client,
      reqPerSec: reqs.rate ?? null,
      httpAvg: dur.avg ?? null,
      httpP95: dur['p(95)'] ?? null,
      upstreamAvg: upstream.avg ?? null,
      upstreamP95: upstream['p(95)'] ?? null,
      errorRate: failed.value ?? null,
    })
  }
  return rows
}

function fmt(n, digits = 2) {
  return n === null || n === undefined ? 'n/a' : Number(n).toFixed(digits)
}

function printTable(rows) {
  const bySweep = {}
  for (const r of rows) {
    const key = r.sweep
    bySweep[key] = bySweep[key] || []
    bySweep[key].push(r)
  }

  for (const sweep of Object.keys(bySweep)) {
    const label = sweep === 'vus' ? 'CONCURRENCY SWEEP (constant-vus)' : 'THROUGHPUT SWEEP (constant-arrival-rate)'
    console.log(`\n=== ${label} ===`)
    const grouped = {}
    for (const r of bySweep[sweep]) {
      const key = `${r.profile}|${r.param}`
      grouped[key] = grouped[key] || {}
      grouped[key][r.client] = r
    }
    const header = [
      'profile', sweep === 'vus' ? 'vus' : 'rate/s',
      'native req/s', 'wreq req/s',
      'native http p95', 'wreq http p95',
      'native client p95', 'wreq client p95',
      'native err%', 'wreq err%',
    ]
    console.log(header.join(' | '))
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const [pa, va] = a.split('|')
      const [pb, vb] = b.split('|')
      return pa === pb ? Number(va) - Number(vb) : pa.localeCompare(pb)
    })
    for (const key of sortedKeys) {
      const [profile, param] = key.split('|')
      const n = grouped[key].native
      const w = grouped[key].wreq
      console.log([
        profile, param,
        fmt(n?.reqPerSec, 0), fmt(w?.reqPerSec, 0),
        fmt(n?.httpP95), fmt(w?.httpP95),
        fmt(n?.upstreamP95), fmt(w?.upstreamP95),
        fmt((n?.errorRate ?? 0) * 100), fmt((w?.errorRate ?? 0) * 100),
      ].join(' | '))
    }
  }
}

function writeCsv(rows) {
  const header = 'sweep,profile,param,client,req_per_sec,http_avg_ms,http_p95_ms,client_avg_ms,client_p95_ms,error_rate\n'
  const lines = rows.map((r) =>
    [r.sweep, r.profile, r.param, r.client, r.reqPerSec, r.httpAvg, r.httpP95, r.upstreamAvg, r.upstreamP95, r.errorRate].join(',')
  )
  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.csv'), header + lines.join('\n') + '\n')
}

const rows = loadResults()
if (rows.length === 0) {
  console.log('No result files found in bench/results/. Run bench/run-matrix.sh first.')
  process.exit(0)
}
printTable(rows)
writeCsv(rows)
console.log(`\nCSV written to ${path.join(RESULTS_DIR, 'summary.csv')}`)
console.log('Note: "client p95" = x-upstream-ms header (gateway\'s own outbound call, isolates the library from proxy/network overhead). "http p95" = k6\'s full k6->gateway->upstream->back round trip.')
