// Streaming response bodies (`stream: true`). See docs/streaming-design.md.
//
// Layered deliberately: resource behaviour (does it actually stay bounded and
// release connections), then stream semantics, then error timing. The
// memory-ceiling proof lives in bench/memory-large-file.mjs because it needs a
// child process and multi-GB transfers; everything cheap enough to run on every
// commit lives here.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { fetch, FetchError, clearClientCache } = require('../index.js')

function withServer(handler, run) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`
      try {
        resolve(await run(base, server))
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

/** Serves `n` copies of a 64 KiB block, so bodies are large without a fixture. */
const BLOCK = Buffer.alloc(64 * 1024, 0xab)
function blocksHandler(n) {
  return (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(n * BLOCK.length),
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
  }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------- semantics

test('streamed body round-trips byte-exactly', async () => {
  const n = 40 // 2.5 MiB
  await withServer(blocksHandler(n), async (base) => {
    const res = await fetch(base, { stream: true })
    const chunks = []
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk))
    const got = Buffer.concat(chunks)
    assert.equal(got.length, n * BLOCK.length)
    assert.equal(sha(got), sha(Buffer.concat(Array(n).fill(BLOCK))))
  })
})

test('chunks are Uint8Array, and arrive in more than one piece', async () => {
  await withServer(blocksHandler(40), async (base) => {
    const res = await fetch(base, { stream: true })
    let count = 0
    let allUint8 = true
    for await (const chunk of res.body) {
      count++
      if (!(chunk instanceof Uint8Array)) allUint8 = false
    }
    assert.ok(allUint8, 'every chunk should be a Uint8Array')
    assert.ok(count > 1, `expected a multi-chunk body, got ${count} chunk(s)`)
  })
})

test('response.body is a ReadableStream and is stable across reads', async () => {
  await withServer(
    (req, res) => res.end('x'),
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.ok(res.body instanceof ReadableStream)
      assert.equal(res.body, res.body, 'body getter must be idempotent')
    }
  )
})

test('headers are available before the body is consumed', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'x-marker': 'present', 'content-type': 'text/plain' })
      res.end('body')
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.equal(res.headers.get('x-marker'), 'present')
      assert.equal(res.bodyUsed, false)
      assert.equal(await res.text(), 'body')
    }
  )
})

test('204 has a null body, matching WHATWG', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(204)
      res.end()
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.equal(res.status, 204)
      assert.equal(res.body, null)
      assert.equal(await res.text(), '')
    }
  )
})

test('empty 200 body yields a stream that closes immediately', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': '0' })
      res.end()
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.notEqual(res.body, null, '200 must expose a stream even when empty')
      const chunks = []
      for await (const c of res.body) chunks.push(c)
      assert.equal(chunks.length, 0)
    }
  )
})

test('gzip is decompressed transparently while streaming', async () => {
  const zlib = require('node:zlib')
  const payload = 'compressed payload '.repeat(5000)
  const gz = zlib.gzipSync(Buffer.from(payload))
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gz.length })
      res.end(gz)
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      const chunks = []
      for await (const c of res.body) chunks.push(Buffer.from(c))
      assert.equal(Buffer.concat(chunks).toString(), payload)
    }
  )
})

test('body survives a redirect and reflects the final response', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/from') {
        res.writeHead(302, { Location: '/to' })
        res.end()
      } else {
        res.writeHead(200)
        res.end('arrived')
      }
    },
    async (base) => {
      const res = await fetch(`${base}/from`, { stream: true })
      assert.equal(res.redirected, true)
      assert.ok(res.url.endsWith('/to'))
      assert.equal(await res.text(), 'arrived')
    }
  )
})

// ------------------------------------------------------------ WHATWG one-shot

test('bodyUsed flips and a second read throws (unlike the buffered path)', async () => {
  await withServer(
    () => {},
    async () => {}
  )
  await withServer(
    (req, res) => res.end('hello'),
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.equal(res.bodyUsed, false)
      assert.equal(await res.text(), 'hello')
      assert.equal(res.bodyUsed, true)
      await assert.rejects(() => res.text(), TypeError)
    }
  )
})

test('buffered path stays re-readable — the documented divergence', async () => {
  await withServer(
    (req, res) => res.end('hello'),
    async (base) => {
      const res = await fetch(base) // no stream: true
      assert.equal(await res.text(), 'hello')
      assert.equal(await res.text(), 'hello', 'buffered bodies are deliberately re-readable')
    }
  )
})

// -------------------------------------------------------------------- limits

test('explicit maxResponseBytes aborts a streamed body mid-transfer', async () => {
  await withServer(blocksHandler(200), async (base) => {
    const res = await fetch(base, { stream: true, maxResponseBytes: 128 * 1024 })
    let seen = 0
    await assert.rejects(
      async () => {
        for await (const chunk of res.body) seen += chunk.length
      },
      (err) => {
        assert.equal(err.code, 'RESPONSE_TOO_LARGE')
        return true
      }
    )
    assert.ok(seen > 0, 'should have delivered chunks before tripping the cap')
  })
})

test('no maxResponseBytes means no cap when streaming', async () => {
  // 40 MiB — comfortably past the 32 MiB buffered default, which must not apply.
  const n = 640
  await withServer(blocksHandler(n), async (base) => {
    const res = await fetch(base, { stream: true })
    let total = 0
    for await (const chunk of res.body) total += chunk.length
    assert.equal(total, n * BLOCK.length)
  })
})

test('buffering accessors re-apply the 32 MiB cap on a streamed response', async () => {
  // Streaming is uncapped, but .text() materializes — it must refuse, not OOM.
  const n = 544 // 34 MiB
  await withServer(blocksHandler(n), async (base) => {
    const res = await fetch(base, { stream: true })
    await assert.rejects(
      () => res.text(),
      (err) => {
        assert.ok(err instanceof FetchError)
        assert.equal(err.code, 'RESPONSE_TOO_LARGE')
        return true
      }
    )
  })
})

// -------------------------------------------------------------- cancellation

test('cancel() mid-stream stops the transfer and leaves the client usable', async () => {
  await withServer(blocksHandler(4000), async (base) => {
    const res = await fetch(base, { stream: true })
    const reader = res.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    await reader.cancel()

    // The whole point: the client is still healthy afterwards.
    const again = await fetch(base, { stream: true, maxResponseBytes: 64 * 1024 * 8 })
    let n = 0
    try {
      for await (const c of again.body) n += c.length
    } catch {
      /* the cap may trip; we only care that a new request works at all */
    }
    assert.ok(n > 0, 'a follow-up request must still succeed after a cancel')
  })
})

test('cancel() while a read is parked does not hang', async () => {
  // Server sends one chunk then stalls forever, so read() is genuinely blocked
  // on the network when cancel arrives. Without select! on the cancellation
  // token this would wait for the socket instead of returning.
  const PRELUDE = Buffer.from('0123456789abcdef') // 16 bytes, then silence
  let stalled
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(PRELUDE)
      stalled = res // never end
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      const reader = res.body.getReader()

      // Drain exactly what the server sent. A single read() is NOT enough to
      // guarantee a park: hyper can split one write across several chunks, so
      // the next read would be served from the queue and never touch the
      // socket — which silently defeats the whole point of this test.
      let drained = 0
      while (drained < PRELUDE.length) {
        const { done, value } = await reader.read()
        if (done) break
        drained += value.length
      }
      assert.equal(drained, PRELUDE.length)

      const pending = reader.read() // now genuinely parked on the socket
      assert.equal(
        res.body.locked,
        true,
        'a reader must hold the lock for this to be the hard case'
      )

      await res.cancel()

      // Assert the parked read actually SETTLES, not merely that we did not time
      // out. An earlier version cancelled nothing on this branch (it re-called
      // takeBody(), already consumed, and swallowed the null via `?.`), so this
      // read hung forever — and a weaker "did not throw" assertion hid it.
      const outcome = await Promise.race([
        pending.then(
          () => ({ settled: true }),
          () => ({ settled: true })
        ),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 5000)),
      ])
      assert.ok(outcome.settled, 'cancel() must unblock a read parked on the socket')
      if (stalled) stalled.end()
    }
  )
})

test('asyncDispose cancels an undrained body', async () => {
  await withServer(blocksHandler(2000), async (base) => {
    const res = await fetch(base, { stream: true })
    assert.equal(typeof res[Symbol.asyncDispose], 'function')
    await res[Symbol.asyncDispose]()
    assert.equal(res.bodyUsed, true, 'disposing marks the body consumed')
    // And the client is still usable afterwards.
    const next = await fetch(base, { stream: true })
    await next.cancel()
    assert.equal(next.status, 200)
  })
})

// ------------------------------------------- WHATWG conformance regressions
//
// Each of these encodes a divergence from native fetch (undici) that shipped in
// the first streaming cut. The expected values were taken by running the same
// scenario against `globalThis.fetch`, not from reading the spec.

test('cancelling immediately after fetch() releases the connection', async () => {
  // Cancelling before any read means no read() is ever in flight to observe the
  // cancellation token, so the native side must drop the stream eagerly. If it
  // waits for GC instead, sockets pile up under repeated early cancels.
  const live = new Set()
  const server = http.createServer(blocksHandler(4000))
  server.on('connection', (socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (let i = 0; i < 25; i++) {
      const res = await fetch(base, { stream: true })
      await res.cancel() // never read a single chunk
    }
    // Give the released sockets a moment to finish closing.
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(
      live.size <= 2,
      `expected early cancels to release connections, but ${live.size} were still open`
    )
  } finally {
    for (const s of live) s.destroy()
    server.close()
  }
})

test('touching response.body does not mark it used (no speculative prefetch)', async () => {
  await withServer(
    (req, res) => res.end('hello'),
    async (base) => {
      const res = await fetch(base, { stream: true })
      const stream = res.body
      assert.ok(stream instanceof ReadableStream)
      // Yield: at a non-zero highWaterMark the stream would prefetch here.
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(res.bodyUsed, false, 'an untouched stream must not count as consumed')
      assert.equal(await res.text(), 'hello', 'and the body must still be readable')
    }
  )
})

test('null-body statuses expose body === null', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(Number(req.url.slice(1)))
      res.end()
    },
    async (base) => {
      for (const status of [204, 205, 304]) {
        const res = await fetch(`${base}/${status}`, { stream: true })
        assert.equal(res.body, null, `status ${status} must have a null body`)
      }
    }
  )
})

test('a HEAD response has a null body regardless of status', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' })
      res.end(req.method === 'HEAD' ? undefined : 'hello')
    },
    async (base) => {
      const res = await fetch(base, { stream: true, method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(res.body, null)
    }
  )
})

test('a null body stays reusable and never marks bodyUsed', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(204)
      res.end()
    },
    async (base) => {
      const res = await fetch(base, { stream: true })
      assert.equal(await res.text(), '')
      assert.equal(res.bodyUsed, false, 'a null body can never be disturbed')
      assert.equal(await res.text(), '', 'so the accessors stay callable')
      assert.equal(await res.text(), '')
    }
  )
})

test('a null-body response releases its native body instead of retaining it', async () => {
  // The null-body branch returns `body === null` without ever handing the
  // native stream to JS. If it also fails to release it, the stream and its
  // socket stay alive until GC — harmless for a 204, but a real retention for
  // an upgrade-style response. Observable proxy: the connection must close.
  const live = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(204)
    res.end()
  })
  server.on('connection', (socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (let i = 0; i < 15; i++) {
      const res = await fetch(base, { stream: true })
      assert.equal(res.body, null)
    }
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(live.size <= 2, `${live.size} connections still open after null-body responses`)
  } finally {
    for (const s of live) s.destroy()
    server.close()
  }
})

test('maxResponseBytes: 0 rejects in both modes, rather than meaning unlimited', async () => {
  await withServer(
    (req, res) => res.end('hello'),
    async (base) => {
      await assert.rejects(
        async () => {
          const res = await fetch(base, { stream: true, maxResponseBytes: 0 })
          for await (const chunk of res.body) void chunk
        },
        (err) => {
          assert.equal(err.code, 'RESPONSE_TOO_LARGE')
          return true
        }
      )
      await assert.rejects(
        () => fetch(base, { maxResponseBytes: 0 }),
        (err) => {
          assert.equal(err.code, 'RESPONSE_TOO_LARGE')
          return true
        }
      )
    }
  )
})

// ------------------------------------------------------------- error timing

test('a mid-body failure rejects from the stream, not from fetch()', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': String(10 * BLOCK.length) })
      res.write(BLOCK)
      setTimeout(() => res.socket.destroy(), 20) // truncate
    },
    async (base) => {
      // fetch() itself resolves: headers already arrived.
      const res = await fetch(base, { stream: true })
      assert.equal(res.status, 200)
      let seen = 0
      await assert.rejects(async () => {
        for await (const chunk of res.body) seen += chunk.length
      })
      assert.ok(seen > 0, 'the first chunk should arrive before the truncation')
    }
  )
})

test('the same failure rejects from fetch() on the buffered path', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': String(10 * BLOCK.length) })
      res.write(BLOCK)
      setTimeout(() => res.socket.destroy(), 20)
    },
    async (base) => {
      await assert.rejects(() => fetch(base, { maxResponseBytes: 10 * 1024 * 1024 }))
    }
  )
})

// ------------------------------------------------------------ integration

test('pipes to a file with pipeline() — the documented download idiom', async () => {
  const n = 100 // 6.25 MiB
  const out = path.join(os.tmpdir(), `myfetch-stream-${process.pid}-${Date.now()}.bin`)
  try {
    await withServer(blocksHandler(n), async (base) => {
      const res = await fetch(base, { stream: true })
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out))
    })
    const stat = fs.statSync(out)
    assert.equal(stat.size, n * BLOCK.length)
    assert.equal(sha(fs.readFileSync(out)), sha(Buffer.concat(Array(n).fill(BLOCK))))
  } finally {
    fs.rmSync(out, { force: true })
  }
})

test('an in-flight body survives clearClientCache()', async () => {
  const n = 200
  await withServer(blocksHandler(n), async (base) => {
    const res = await fetch(base, { stream: true })
    const reader = res.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)

    // Evicting the cached client must not kill a transfer already in progress:
    // the Response owns what it needs to finish reading.
    clearClientCache()

    let total = first.value.length
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
    }
    assert.equal(total, n * BLOCK.length)
  })
})
