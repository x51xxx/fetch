'use strict'

// Focused regressions for streaming behaviours not covered by
// streaming.test.js or streaming-resources.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')
const { brotliCompressSync, deflateSync } = require('node:zlib')

const { fetch, clearSession } = require('../index.js')

const KiB = 1024
const MiB = 1024 * KiB
const BLOCK = Buffer.alloc(64 * KiB, 0xa7)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function withServer(handler, run) {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    return await run(base, server)
  } finally {
    await new Promise((resolve) => {
      server.close(resolve)
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    })
  }
}

function pumpBody(res, total, block = BLOCK, onWrite) {
  let sent = 0
  const pump = () => {
    while (sent < total && !res.destroyed) {
      const size = Math.min(block.length, total - sent)
      sent += size
      if (onWrite) onWrite(size, sent)
      if (!res.write(block.subarray(0, size))) {
        res.once('drain', pump)
        return
      }
    }
    if (!res.destroyed) res.end()
  }
  pump()
}

// Regression: a speculative or eager native read loop would let both origins
// finish writing, even though one JS consumer asks for only one chunk at a time.
test('a slow reader propagates backpressure to the server', async (t) => {
  const total = 80 * MiB
  const progress = new Map()

  await withServer(
    (req, res) => {
      const state = { bytes: 0 }
      progress.set(req.url, state)
      res.writeHead(200, { 'content-length': String(total) })
      pumpBody(res, total, BLOCK, (size) => {
        state.bytes += size
      })
    },
    async (base) => {
      const [slowResponse, fastResponse] = await Promise.all([
        fetch(`${base}/slow`, { stream: true }),
        fetch(`${base}/fast`, { stream: true }),
      ])
      const slowReader = slowResponse.body.getReader()
      const fastReader = fastResponse.body.getReader()

      const slowDrain = (async () => {
        for (;;) {
          const { done } = await slowReader.read()
          if (done) return
          await delay(40)
        }
      })()
      const fastDrain = (async () => {
        for (;;) {
          const { done } = await fastReader.read()
          if (done) return
        }
      })()

      try {
        // Two seconds is deliberately much wider than local scheduling noise.
        // The fast side need only clear 40 MiB, while the slow side may reach
        // 60% of it and still pass; socket buffers cannot explain that gap.
        await delay(2000)
        const slowBytes = progress.get('/slow').bytes
        const fastBytes = progress.get('/fast').bytes
        t.diagnostic(
          `server accepted ${Math.round(slowBytes / MiB)} MiB slow vs ${Math.round(fastBytes / MiB)} MiB fast`
        )
        assert.ok(
          fastBytes >= 40 * MiB,
          `fast control wrote only ${Math.round(fastBytes / MiB)} MiB`
        )
        assert.ok(
          slowBytes <= fastBytes * 0.6,
          `slow producer was not substantially throttled (${slowBytes} vs ${fastBytes} bytes)`
        )
      } finally {
        await Promise.allSettled([slowReader.cancel(), fastReader.cancel()])
        await Promise.allSettled([slowDrain, fastDrain])
      }
    }
  )
})

function compressionPayload() {
  const payload = Buffer.alloc(768 * KiB)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + (i >>> 8)) & 0xff
  return payload
}

async function assertStreamingDecompression(encoding, compress) {
  const payload = compressionPayload()
  const encoded = compress(payload)
  assert.notDeepEqual(encoded.subarray(0, 64), payload.subarray(0, 64))

  await withServer(
    (req, res) => {
      res.writeHead(200, {
        'content-encoding': encoding,
        'content-length': String(encoded.length),
      })
      res.end(encoded)
    },
    async (base) => {
      const response = await fetch(base, { stream: true })
      const chunks = []
      let offset = 0
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk)
        assert.deepEqual(
          bytes,
          payload.subarray(offset, offset + bytes.length),
          'each emitted chunk must contain decoded bytes, not compressed wire bytes'
        )
        offset += bytes.length
        chunks.push(bytes)
      }
      assert.equal(offset, payload.length)
      assert.equal(sha(Buffer.concat(chunks)), sha(payload))
    }
  )
}

// Regression: enabling only gzip in wreq would expose Brotli wire bytes to JS.
test('br is decompressed before streamed chunks reach the reader', async () => {
  await assertStreamingDecompression('br', brotliCompressSync)
})

// Regression: enabling only gzip/Brotli in wreq would expose deflate wire bytes.
test('deflate is decompressed before streamed chunks reach the reader', async () => {
  await assertStreamingDecompression('deflate', deflateSync)
})

// Regression: clearing the session cache could drop the sole client/jar owner
// and abort a response whose body is still waiting on the origin.
test('an in-flight streamed body survives clearSession()', async () => {
  const total = 8 * MiB
  const session = `stream-gap-${process.pid}-${Date.now()}`
  let releaseOrigin
  const originGate = new Promise((resolve) => {
    releaseOrigin = resolve
  })

  try {
    await withServer(
      async (req, res) => {
        res.writeHead(200, { 'content-length': String(total) })
        res.write(BLOCK)
        await originGate
        pumpBody(res, total - BLOCK.length)
      },
      async (base) => {
        const response = await fetch(base, { stream: true, session })
        const reader = response.body.getReader()
        const first = await reader.read()
        assert.equal(first.done, false)

        const removed = clearSession(session)
        assert.ok(removed >= 1, 'the test must actually evict a cached session client')
        releaseOrigin()

        const digest = crypto.createHash('sha256')
        digest.update(first.value)
        let received = first.value.length
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.length
          digest.update(value)
        }
        assert.equal(received, total)
        assert.equal(digest.digest('hex'), sha(Buffer.alloc(total, BLOCK[0])))
      }
    )
  } finally {
    releaseOrigin()
    clearSession(session)
  }
})

// Regression: changing the native cumulative check from `>` to `>=` would
// reject a legal response whose decoded size lands exactly on the explicit cap.
test('maxResponseBytes accepts a body exactly at the boundary', async () => {
  const limit = 256 * KiB
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': String(limit) })
      res.end(Buffer.alloc(limit, 0x4d))
    },
    async (base) => {
      const response = await fetch(base, { stream: true, maxResponseBytes: limit })
      const bytes = await response.bytes()
      assert.equal(bytes.length, limit)
      assert.ok(bytes.every((byte) => byte === 0x4d))
    }
  )
})

// Regression: the JS buffering guard has its own boundary check, independent
// of maxResponseBytes; `>= 32 MiB` would reject the documented maximum itself.
test('a buffering accessor accepts exactly its 32 MiB cap', async () => {
  const total = 32 * MiB
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': String(total) })
      pumpBody(res, total)
    },
    async (base) => {
      const response = await fetch(base, { stream: true })
      const bytes = await response.bytes()
      assert.equal(bytes.length, total)
      assert.equal(bytes[0], BLOCK[0])
      assert.equal(bytes[bytes.length - 1], BLOCK[0])
    }
  )
})

// Regression: reader ownership must live in the WHATWG stream, not consume the
// native FetchBody permanently when the first reader releases its lock.
test('a reader can release its lock and a new reader can finish the body', async () => {
  let releaseTail
  const tailGate = new Promise((resolve) => {
    releaseTail = resolve
  })
  const head = Buffer.from('reader-one:')
  const tail = Buffer.from('reader-two')

  try {
    await withServer(
      async (req, res) => {
        res.writeHead(200, { 'content-length': String(head.length + tail.length) })
        res.write(head)
        await tailGate
        res.end(tail)
      },
      async (base) => {
        const response = await fetch(base, { stream: true })
        const firstReader = response.body.getReader()
        const first = await firstReader.read()
        assert.equal(first.done, false)
        firstReader.releaseLock()

        assert.equal(response.bodyUsed, true)
        const secondReader = response.body.getReader()
        releaseTail()
        const chunks = [Buffer.from(first.value)]
        for (;;) {
          const { done, value } = await secondReader.read()
          if (done) break
          chunks.push(Buffer.from(value))
        }
        assert.equal(Buffer.concat(chunks).toString(), `${head}${tail}`)
        secondReader.releaseLock()
      }
    )
  } finally {
    releaseTail()
  }
})

// Regression: sharing a native stream/cancellation token between responses
// would let cancelling one concurrent download truncate its siblings.
test('concurrent streamed responses keep body and cancellation state isolated', async () => {
  const total = 4 * MiB
  await withServer(
    (req, res) => {
      const byte = Number(req.url.slice(1))
      const block = Buffer.alloc(BLOCK.length, byte)
      res.writeHead(200, { 'content-length': String(total) })
      pumpBody(res, total, block)
    },
    async (base) => {
      const responses = await Promise.all(
        [0x31, 0x52, 0x73].map((byte) => fetch(`${base}/${byte}`, { stream: true }))
      )
      const readers = responses.map((response) => response.body.getReader())
      const first = await Promise.all(readers.map((reader) => reader.read()))
      await readers[0].cancel()

      const outputs = [1, 2].map((index) => [Buffer.from(first[index].value)])
      const active = new Set([1, 2])
      while (active.size > 0) {
        const indexes = [...active]
        const reads = await Promise.all(indexes.map((index) => readers[index].read()))
        for (let i = 0; i < reads.length; i++) {
          const index = indexes[i]
          if (reads[i].done) active.delete(index)
          else outputs[index - 1].push(Buffer.from(reads[i].value))
        }
      }

      for (const [outputIndex, byte] of [0x52, 0x73].entries()) {
        const body = Buffer.concat(outputs[outputIndex])
        assert.equal(body.length, total)
        assert.ok(body.every((value) => value === byte))
      }
    }
  )
})
