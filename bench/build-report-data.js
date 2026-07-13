const fs = require('node:fs')
const path = require('node:path')

const RESULTS_DIR = path.join(__dirname, 'results')

function parseCsv() {
  const text = fs.readFileSync(path.join(RESULTS_DIR, 'summary.csv'), 'utf8')
  const [headerLine, ...lines] = text.trim().split('\n')
  const headers = headerLine.split(',')
  return lines.map((line) => {
    const cells = line.split(',')
    const row = {}
    headers.forEach((h, i) => {
      row[h] = ['sweep', 'profile', 'client'].includes(h) ? cells[i] : Number(cells[i])
    })
    return row
  })
}

function parseColdProbe() {
  const text = fs.readFileSync(path.join(RESULTS_DIR, 'cold-tls-probe-example.txt'), 'utf8')
  const native = []
  const wreq = []
  for (const line of text.split('\n')) {
    const m = line.match(/trial \d+\/\d+: native=([\d.]+)ms\s+wreq=([\d.]+)ms/)
    if (m) {
      native.push(Number(m[1]))
      wreq.push(Number(m[2]))
    }
  }
  return { native, wreq }
}

function groupBySweep(rows) {
  const bySweep = { vus: {}, rate: {} }
  for (const r of rows) {
    const profiles = bySweep[r.sweep]
    profiles[r.profile] = profiles[r.profile] || []
    profiles[r.profile].push(r)
  }
  for (const sweep of Object.keys(bySweep)) {
    for (const profile of Object.keys(bySweep[sweep])) {
      bySweep[sweep][profile].sort((a, b) => a.param - b.param)
    }
  }
  return bySweep
}

const PROFILE_META = {
  fast_small: { label: '512 B, 0 ms delay', desc: 'baseline: tiny payload, instant backend' },
  small_fast: { label: '4 KB, 0 ms delay', desc: 'small JSON-ish payload, instant backend' },
  typical: { label: '4 KB, 20 ms delay', desc: 'typical API call' },
  large_nodelay: { label: '256 KB, 0 ms delay', desc: 'large payload, instant backend' },
  slow_large: { label: '64 KB, 100 ms delay', desc: 'slow backend, medium payload' },
  huge_body: { label: '2 MB, 0 ms delay', desc: 'large transfer, backend-bound throughput' },
}

const rows = parseCsv()
const cold = parseColdProbe()
const grouped = groupBySweep(rows)

const data = {
  generatedNote: 'bench/results/summary.csv + bench/results/cold-tls-probe-example.txt',
  profileMeta: PROFILE_META,
  vus: grouped.vus,
  rate: grouped.rate,
  cold,
}

fs.writeFileSync(path.join(__dirname, 'report-data.json'), JSON.stringify(data))
console.log(
  'wrote',
  path.join(__dirname, 'report-data.json'),
  `(${rows.length} rows, ${cold.native.length} cold trials)`
)
