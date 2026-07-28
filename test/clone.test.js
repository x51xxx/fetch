// `clone()` on both response paths. The two answers are deliberately opposite:
// the buffered response clones for free, the streamed one refuses. Rationale and
// the alternatives that were rejected: docs/clone-and-chunk-cap.md.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { fetch, FetchResponse } = require('../index.js')

function withServer(handler, run) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`
      try {
        resolve(await run(base))
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

const hello = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'x-origin': 'server' })
  res.end('hello clone')
}

// ------------------------------------------------------------------ buffered

test('clone() returns an independent response with the same body', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base)
    const copy = res.clone()
    assert.ok(copy instanceof FetchResponse)
    assert.notEqual(copy, res, 'clone must be a distinct object')
    assert.equal(await res.text(), 'hello clone')
    assert.equal(await copy.text(), 'hello clone')
  })
})

test('clone() copies metadata, not just the body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-origin': 'server' })
      res.end('{"ok":true}')
    },
    async (base) => {
      const res = await fetch(base)
      const copy = res.clone()
      assert.equal(copy.status, 201)
      assert.equal(copy.ok, true)
      assert.equal(copy.url, res.url)
      assert.equal(copy.redirected, res.redirected)
      assert.equal(copy.headers.get('x-origin'), 'server')
      assert.deepEqual(await copy.json(), { ok: true })
    }
  )
})

// Regression: sharing the wrapper's state (rather than only the native body)
// would let reading one response mark the other consumed.
test('bodyUsed is tracked independently on the original and the clone', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base)
    const copy = res.clone()
    assert.equal(res.bodyUsed, false)
    assert.equal(copy.bodyUsed, false)

    await res.text()
    assert.equal(res.bodyUsed, true)
    assert.equal(copy.bodyUsed, false, 'reading the original must not consume the clone')

    await copy.text()
    assert.equal(copy.bodyUsed, true)
  })
})

// Regression: the `Headers` object is built lazily and cached per wrapper. If a
// clone shared that cache, mutating one response's headers would leak into the
// other, which no caller would expect from an "independent" copy.
test('the clone gets its own Headers instance', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base)
    const copy = res.clone()
    assert.notEqual(res.headers, copy.headers, 'headers must not be a shared object')

    copy.headers.set('x-origin', 'mutated')
    assert.equal(copy.headers.get('x-origin'), 'mutated')
    assert.equal(res.headers.get('x-origin'), 'server', 'mutation must not leak to the original')
  })
})

// This is the deliberate WHATWG divergence: undici throws here because the body
// is disturbed. On the buffered path `bodyUsed` is advisory and `text()` is
// re-readable, so refusing to clone would be stricter than reading again.
test('clone() after the body was read still works (documented divergence)', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base)
    assert.equal(await res.text(), 'hello clone')
    assert.equal(res.bodyUsed, true)

    const copy = res.clone()
    assert.equal(copy.bodyUsed, false)
    assert.equal(await copy.text(), 'hello clone')
  })
})

test('a clone can itself be cloned', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base)
    const second = res.clone().clone()
    assert.equal(await second.text(), 'hello clone')
    assert.equal(await res.text(), 'hello clone')
  })
})

test('clone() shares the native body rather than copying the payload', async () => {
  // 8 MiB: if clone() duplicated the buffer, four live clones would cost 32 MiB
  // more than one. This asserts the cheap path is actually taken.
  const size = 8 * 1024 * 1024
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': String(size) })
      res.end(Buffer.alloc(size, 0x7a))
    },
    async (base) => {
      const res = await fetch(base, { maxResponseBytes: size + 1024 })
      const before = process.memoryUsage().rss
      const clones = [res.clone(), res.clone(), res.clone(), res.clone()]
      const after = process.memoryUsage().rss
      assert.equal(clones.length, 4)
      assert.ok(
        after - before < size,
        `cloning 4x cost ${after - before} bytes; a payload copy would cost at least ${size}`
      )
      assert.equal((await clones[3].bytes()).length, size)
    }
  )
})

// ----------------------------------------------------------------- streaming

// Regression: implementing streamed clone() via tee() would silently reintroduce
// unbounded buffering. Refusing is the designed behaviour, not an oversight.
test('clone() throws on a streamed response and points at tee()', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base, { stream: true })
    assert.throws(
      () => res.clone(),
      (err) => {
        assert.ok(err instanceof TypeError)
        assert.match(err.message, /tee\(\)/, 'the error must name the supported alternative')
        return true
      }
    )
    // The refusal must not disturb the body.
    assert.equal(res.bodyUsed, false)
    assert.equal(await res.text(), 'hello clone')
  })
})

// The refusal is about clone() specifically — the underlying primitive stays
// available, so a caller who accepts tee()'s memory cost can still opt in.
test('response.body.tee() still works on a streamed response', async () => {
  await withServer(hello, async (base) => {
    const res = await fetch(base, { stream: true })
    const [a, b] = res.body.tee()
    const read = async (stream) => {
      const chunks = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString()
    }
    const [first, second] = await Promise.all([read(a), read(b)])
    assert.equal(first, 'hello clone')
    assert.equal(second, 'hello clone')
  })
})
