// Memory behaviour on large responses.
//
// Serves N MiB of generated content (no on-disk fixture), downloads it with
// several strategies, and reports PEAK RSS while a checksum is computed over
// every byte. Each scenario runs in its own child process so RSS is isolated.
//
//   node bench/memory-large-file.mjs [sizeMiB ...]
//
// The point: a buffered body costs RSS proportional to the response, twice over
// for the native addon (Rust `Vec<u8>` + the V8 copy in `array_buffer`). A
// streaming consumer stays flat regardless of size. This quantifies that gap.
//
// The published figures were taken on an Apple M3 Max (arm64, 16 cores, 48 GB,
// macOS 26.3, Node v24.18.0) over loopback. Absolute numbers move with hardware,
// kernel, allocator, and GC timing — the buffered columns swing 20-25% between
// runs on the same machine. What reproduces is the *shape*: the streaming column
// stays flat as the body grows, the buffered one scales with it. Re-run here
// before quoting a number for a different target.

import http from 'node:http'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const MiB = 1024 * 1024

// Deterministic 1 MiB block; byte i is (i % 251).
const BLOCK = Buffer.alloc(MiB)
for (let i = 0; i < MiB; i++) BLOCK[i] = i % 251
const BLOCK_SUM = BLOCK.reduce((a, b) => a + b, 0)

/** Identical work in every scenario, so the comparison is only about memory. */
function checksum(u8, state) {
  let s = state
  for (let i = 0; i < u8.length; i++) s = (s + u8[i]) >>> 0
  return s
}

// ---------------------------------------------------------------- child mode
if (process.argv[2] === '--child') {
  const [, , , scenario, url, sizeMiB] = process.argv
  const total = Number(sizeMiB) * MiB

  let peak = process.memoryUsage().rss
  const sampler = setInterval(() => {
    const r = process.memoryUsage().rss
    if (r > peak) peak = r
  }, 15)
  sampler.unref()

  const t0 = Date.now()
  let sum = 0
  let bytes = 0

  try {
    if (scenario === 'undici-stream') {
      const res = await globalThis.fetch(url)
      for await (const chunk of res.body) {
        bytes += chunk.length
        sum = checksum(chunk, sum)
      }
    } else if (scenario === 'undici-buffered') {
      const res = await globalThis.fetch(url)
      const buf = new Uint8Array(await res.arrayBuffer())
      bytes = buf.length
      sum = checksum(buf, sum)
    } else if (scenario === 'mine-stream') {
      const { fetch } = require('../index.js')
      const res = await fetch(url, { stream: true })
      for await (const chunk of res.body) {
        bytes += chunk.length
        sum = checksum(chunk, sum)
      }
    } else if (scenario === 'mine-buffered') {
      const { fetch } = require('../index.js')
      const res = await fetch(url, { maxResponseBytes: total + MiB })
      const buf = await res.bytes()
      bytes = buf.length
      sum = checksum(buf, sum)
    } else if (scenario === 'mine-default-cap') {
      const { fetch } = require('../index.js')
      const res = await fetch(url) // no maxResponseBytes -> 32 MiB default
      const buf = await res.bytes()
      bytes = buf.length
      sum = checksum(buf, sum)
    } else {
      throw new Error(`unknown scenario ${scenario}`)
    }

    const r = process.memoryUsage().rss
    if (r > peak) peak = r
    process.send({ ok: true, peak, bytes, sum, ms: Date.now() - t0 })
  } catch (e) {
    const r = process.memoryUsage().rss
    if (r > peak) peak = r
    process.send({
      ok: false,
      peak,
      bytes,
      ms: Date.now() - t0,
      err: `${e.constructor.name}: ${String(e.message).slice(0, 70)}`,
      code: e.code,
    })
  }
  process.exit(0)
}

// ----------------------------------------------------------- orchestrator
const SIZES = process.argv.slice(2).map(Number).filter(Boolean)
const sizes = SIZES.length ? SIZES : [256, 1024]

const server = http.createServer((req, res) => {
  const n = Number(new URL(req.url, 'http://x').searchParams.get('mib'))
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(n * MiB),
  })
  let sent = 0
  const pump = () => {
    while (sent < n) {
      sent++
      if (!res.write(BLOCK)) return res.once('drain', pump) // honour backpressure
    }
    res.end()
  }
  pump()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const run = (scenario, url, mib) =>
  new Promise((resolve) => {
    const child = fork(SELF, ['--child', scenario, url, String(mib)], { silent: true })
    let msg = null
    child.on('message', (m) => {
      msg = m
    })
    child.on('exit', (code, sig) =>
      resolve(msg ?? { ok: false, peak: 0, err: `child died (code=${code} sig=${sig})` })
    )
  })

const SCENARIOS = [
  ['undici-stream', 'undici, streaming (for await res.body)'],
  ['mine-stream', '@trishchuk/fetch, streaming (stream: true)'],
  ['undici-buffered', 'undici, buffered (arrayBuffer)'],
  ['mine-buffered', '@trishchuk/fetch, buffered (bytes)'],
  ['mine-default-cap', '@trishchuk/fetch, default 32 MiB cap'],
]

const mb = (b) => (b / MiB).toFixed(0).padStart(6)

console.log('\n' + '='.repeat(96))
console.log('PEAK RSS WHILE CHECKSUMMING EVERY BYTE OF A GENERATED RESPONSE')
console.log('='.repeat(96))

for (const mib of sizes) {
  const expected = (BLOCK_SUM * mib) >>> 0
  console.log(`\n--- response size: ${mib} MiB  (expected checksum ${expected}) ---`)
  console.log(
    'scenario'.padEnd(42) +
      'peak RSS'.padStart(10) +
      'RSS/size'.padStart(10) +
      'time'.padStart(9) +
      '  result'
  )
  for (const [key, label] of SCENARIOS) {
    const r = await run(key, `${base}/?mib=${mib}`, mib)
    const ratio = r.peak ? (r.peak / (mib * MiB)).toFixed(2) + 'x' : '-'
    const verdict = !r.ok
      ? `FAILED ${r.code ?? ''} ${r.err}`
      : r.sum === expected && r.bytes === mib * MiB
        ? 'ok, checksum matches'
        : `MISMATCH sum=${r.sum} bytes=${r.bytes}`
    console.log(
      label.padEnd(42) +
        mb(r.peak) +
        ' MiB' +
        ratio.padStart(10) +
        `${(r.ms / 1000).toFixed(1)}s`.padStart(9) +
        '  ' +
        verdict
    )
  }
}

console.log('\n' + '='.repeat(96))
server.close()
