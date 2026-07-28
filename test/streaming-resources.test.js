// Resource-level guarantees for streaming: the memory ceiling, and the promise
// that streaming does not move the TLS/HTTP2 fingerprint.
//
// Kept apart from streaming.test.js because these are slower and one needs the
// network. The full multi-GB picture lives in bench/memory-large-file.mjs; this
// file is the cheap regression guard that runs on every commit.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')

// Bind explicitly. Without this, `fetch(...)` in this file silently resolves to
// Node's global (undici) and every assertion below would measure the wrong
// implementation — undici has no 32 MiB accessor cap, so the decompression-bomb
// test in particular would be checking nothing.
const { fetch } = require('../index.js')

const MiB = 1024 * 1024
const BLOCK = Buffer.alloc(MiB, 0x5a)

/** Serves `n` MiB of generated content — no fixture on disk. */
function bigServer(n) {
  return http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(n * MiB),
    })
    let sent = 0
    const pump = () => {
      while (sent < n) {
        sent++
        if (!res.write(BLOCK)) return res.once('drain', pump)
      }
      res.end()
    }
    pump()
  })
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/** Runs `script` in a fresh process so RSS reflects only that download. */
function runChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 400)}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        reject(new Error(`unparseable child output: ${out.slice(0, 300)} / ${err.slice(0, 300)}`))
      }
    })
  })
}

// The headline guarantee. 256 MiB transits while peak RSS must stay far below
// it; a regression to buffering would land around 580 MiB (measured) and trip
// this immediately. Ceiling is generous so it tracks the *shape* of memory use,
// not GC noise.
//
// The reference numbers quoted in comments here were taken on an Apple M3 Max
// (arm64, macOS 26.3, Node v24.18.0). They will differ on other hardware — hence
// the wide ceiling, which asserts "nothing like buffering" rather than a
// specific figure.
const SIZE_MIB = 256
const RSS_CEILING_MIB = 400

test('streaming a 256 MiB body keeps peak RSS well under the body size', async (t) => {
  const server = bigServer(SIZE_MIB)
  const base = await listen(server)
  try {
    const script = `
      const { fetch } = require('./index.js')
      let peak = process.memoryUsage().rss
      const s = setInterval(() => {
        const r = process.memoryUsage().rss
        if (r > peak) peak = r
      }, 10)
      s.unref()
      ;(async () => {
        const res = await fetch(${JSON.stringify(base)}, { stream: true })
        let bytes = 0, sum = 0
        for await (const c of res.body) {
          bytes += c.length
          for (let i = 0; i < c.length; i += 4096) sum = (sum + c[i]) >>> 0
        }
        const r = process.memoryUsage().rss
        if (r > peak) peak = r
        console.log(JSON.stringify({ peak, bytes, sum }))
      })().catch((e) => { console.error(e); process.exit(1) })
    `
    const res = await runChild(script)
    assert.equal(res.bytes, SIZE_MIB * MiB, 'the whole body must arrive')
    const peakMiB = Math.round(res.peak / MiB)
    t.diagnostic(`peak RSS ${peakMiB} MiB for a ${SIZE_MIB} MiB body`)
    assert.ok(
      res.peak < RSS_CEILING_MIB * MiB,
      `peak RSS ${peakMiB} MiB exceeded the ${RSS_CEILING_MIB} MiB ceiling — streaming likely regressed to buffering`
    )
  } finally {
    server.close()
  }
})

test('buffering the same body costs RSS proportional to it (the contrast)', async (t) => {
  const server = bigServer(SIZE_MIB)
  const base = await listen(server)
  try {
    const script = `
      const { fetch } = require('./index.js')
      let peak = process.memoryUsage().rss
      const s = setInterval(() => {
        const r = process.memoryUsage().rss
        if (r > peak) peak = r
      }, 10)
      s.unref()
      ;(async () => {
        const res = await fetch(${JSON.stringify(base)}, { maxResponseBytes: ${(SIZE_MIB + 8) * MiB} })
        const b = await res.bytes()
        const r = process.memoryUsage().rss
        if (r > peak) peak = r
        console.log(JSON.stringify({ peak, bytes: b.length }))
      })().catch((e) => { console.error(e); process.exit(1) })
    `
    const res = await runChild(script)
    assert.equal(res.bytes, SIZE_MIB * MiB)
    t.diagnostic(`buffered peak RSS ${Math.round(res.peak / MiB)} MiB for a ${SIZE_MIB} MiB body`)
    // Not a strict requirement, just documents why streaming exists. Buffering
    // holds the body twice (Rust Vec + the V8 copy), so it cannot be flat.
    assert.ok(
      res.peak > SIZE_MIB * MiB,
      'buffering is expected to hold at least the body size in RSS'
    )
  } finally {
    server.close()
  }
})

// A decompression bomb is the adversarial case for a library that exists to talk
// to hostile servers: a tiny response that expands enormously. Two things must
// hold — streaming it must not blow up memory, and a buffering accessor must
// refuse it rather than trying to materialize it.
//
// The bound that makes this safe is not obvious: tower-http decompresses through
// a fixed 4096-byte buffer (`WrapBody::INTERNAL_BUF_CAPACITY`, verified in
// tower-http-0.6.11/src/compression_utils.rs:152), so a high compression ratio
// yields *more chunks*, never bigger ones. Measured: a 1029:1 gzip bomb decoding
// to 512 MiB produced 131072 chunks of at most 4096 bytes each.
test('a decompression bomb streams safely and is refused by buffering accessors', async (t) => {
  const zlib = require('node:zlib')
  const DECODED = 64 * MiB // comfortably past the 32 MiB accessor cap
  // Build the payload without ever holding DECODED bytes in this process.
  const gzip = zlib.createGzip({ level: 9 })
  const parts = []
  gzip.on('data', (d) => parts.push(d))
  const zero = Buffer.alloc(64 * 1024)
  for (let sent = 0; sent < DECODED; sent += zero.length) {
    if (!gzip.write(zero)) await new Promise((r) => gzip.once('drain', r))
  }
  gzip.end()
  await new Promise((r) => gzip.once('end', r))
  const bomb = Buffer.concat(parts)
  t.diagnostic(
    `bomb ${bomb.length} B -> ${DECODED / MiB} MiB (ratio ${Math.round(DECODED / bomb.length)}:1)`
  )

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(bomb.length) })
    res.end(bomb)
  })
  const base = await listen(server)
  try {
    // 1. Streaming it stays bounded, and no single chunk is anywhere near the cap.
    const streamed = await fetch(base, { stream: true })
    let total = 0
    let maxChunk = 0
    for await (const chunk of streamed.body) {
      total += chunk.length
      if (chunk.length > maxChunk) maxChunk = chunk.length
    }
    assert.equal(total, DECODED, 'the whole bomb must decode')
    t.diagnostic(`largest single chunk: ${maxChunk} B`)
    assert.ok(
      maxChunk <= MiB,
      `a single chunk of ${maxChunk} B would let the accessor cap overshoot materially`
    )

    // 2. A buffering accessor must refuse it, not try to hold 64 MiB.
    const buffered = await fetch(base, { stream: true })
    await assert.rejects(
      () => buffered.text(),
      (err) => {
        assert.equal(err.code, 'RESPONSE_TOO_LARGE')
        return true
      }
    )
  } finally {
    server.close()
  }
})

// Network-gated: this is the single most important invariant in the library, so
// it belongs in the suite, but it needs a real TLS endpoint. Run with
// MYFETCH_NETWORK_TESTS=1 to enable.
test(
  'streaming does not change the TLS/HTTP2 fingerprint',
  { skip: !process.env.MYFETCH_NETWORK_TESTS },
  async (t) => {
    const { fetch, clearClientCache } = require('../index.js')
    const URL_ = 'https://tls.peet.ws/api/all'

    const probe = async (streaming) => {
      // Force a fresh client, hence a fresh TLS handshake. Without this, a
      // resumed session legitimately changes JA4's first segment (extension count
      // shifts when the session ticket is offered) and the comparison is
      // meaningless — a known BoringSSL behaviour, not a fingerprint drift.
      clearClientCache()
      const res = await fetch(URL_, {
        impersonate: 'chrome_147',
        ...(streaming ? { stream: true } : {}),
      })
      if (!streaming) return res.json()
      let text = ''
      for await (const c of res.body) text += Buffer.from(c).toString()
      return JSON.parse(text)
    }

    const buffered = await probe(false)
    const streamed = await probe(true)

    t.diagnostic(`buffered ja4=${buffered.tls.ja4}`)
    t.diagnostic(`streamed ja4=${streamed.tls.ja4}`)

    assert.equal(streamed.tls.ja4, buffered.tls.ja4, 'JA4 must not depend on how the body is read')
    assert.equal(
      streamed.http2?.akamai_fingerprint_hash,
      buffered.http2?.akamai_fingerprint_hash,
      'Akamai HTTP/2 hash must not depend on how the body is read'
    )
    assert.equal(streamed.tls.peetprint_hash, buffered.tls.peetprint_hash)
  }
)
