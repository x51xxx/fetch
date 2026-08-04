// AbortSignal (WHATWG abort semantics).
//
// Layered like the spec itself: rejection identity first (the signal's exact
// `reason` must come back, never a wrapper), then each cancellation point
// (pre-flight, waiting on headers, mid-body on both paths), then the
// distinction abort must keep from consumer cancellation, then listener
// lifecycle (nothing may leak on a long-lived signal).

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { getEventListeners } = require('node:events')

const { fetch, FetchError } = require('../index.js')

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
        server.closeAllConnections()
        server.close()
      }
    })
  })
}

/** Sends headers and `prefix`, then holds the connection open forever. */
function stallAfter(prefix) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    if (prefix) res.write(prefix)
    // never end()
  }
}

/** Never responds at all — the client stays parked waiting for headers. */
function blackHole() {
  return () => {
    /* never respond */
  }
}

const expectReject = async (promise, check) => {
  try {
    await promise
  } catch (err) {
    check(err)
    return
  }
  assert.fail('expected rejection')
}

// ------------------------------------------------------- rejection identity

test('pre-aborted signal rejects with the default AbortError DOMException', async () => {
  const controller = new AbortController()
  controller.abort()
  await expectReject(fetch('http://127.0.0.1:9/', { signal: controller.signal }), (err) => {
    assert.ok(err instanceof DOMException)
    assert.equal(err.name, 'AbortError')
    assert.equal(err.code, 20)
    assert.ok(!(err instanceof FetchError))
  })
})

test('custom abort reason keeps object identity', async () => {
  const reason = { my: 'reason' }
  const controller = new AbortController()
  controller.abort(reason)
  await expectReject(fetch('http://127.0.0.1:9/', { signal: controller.signal }), (err) => {
    assert.equal(err, reason)
  })
})

test('custom abort reason keeps primitive identity (string)', async () => {
  const controller = new AbortController()
  controller.abort('stop right there')
  await expectReject(fetch('http://127.0.0.1:9/', { signal: controller.signal }), (err) => {
    assert.equal(err, 'stop right there')
  })
})

test('a non-AbortSignal signal throws TypeError; null and undefined are accepted', async () => {
  await assert.rejects(fetch('http://127.0.0.1:9/', { signal: {} }), TypeError)
  await assert.rejects(fetch('http://127.0.0.1:9/', { signal: 'nope' }), TypeError)
  // null/undefined mean "no signal" — the request proceeds (and fails on the
  // unroutable address with a FetchError, not a TypeError).
  await assert.rejects(fetch('http://127.0.0.1:9/', { signal: null, timeoutMs: 2000 }), FetchError)
})

// ------------------------------------------------------- cancellation points

test('abort while waiting for headers rejects (buffered path)', async () => {
  await withServer(blackHole(), async (base, server) => {
    const controller = new AbortController()
    server.on('request', () => controller.abort())
    await expectReject(fetch(base, { signal: controller.signal }), (err) => {
      assert.equal(err.name, 'AbortError')
    })
  })
})

test('abort while waiting for headers rejects (streaming path)', async () => {
  await withServer(blackHole(), async (base, server) => {
    const controller = new AbortController()
    server.on('request', () => controller.abort())
    await expectReject(fetch(base, { stream: true, signal: controller.signal }), (err) => {
      assert.equal(err.name, 'AbortError')
    })
  })
})

test('abort mid-body rejects fetch() itself on the buffered path', async () => {
  await withServer(stallAfter(Buffer.alloc(1024, 1)), async (base, server) => {
    const controller = new AbortController()
    const reason = new Error('enough')
    server.on('request', () => setTimeout(() => controller.abort(reason), 50))
    await expectReject(fetch(base, { signal: controller.signal }), (err) => {
      assert.equal(err, reason)
    })
  })
})

test('abort unparks an in-flight streaming read() and errors the body', async () => {
  await withServer(stallAfter(Buffer.from('first chunk')), async (base) => {
    const controller = new AbortController()
    const res = await fetch(base, { stream: true, signal: controller.signal })
    const reader = res.body.getReader()
    const first = await reader.read()
    assert.equal(Buffer.from(first.value).toString(), 'first chunk')

    const parked = reader.read() // parked on the socket — nothing more is coming
    const reason = { tag: 'mid-stream abort' }
    controller.abort(reason)
    await expectReject(parked, (err) => assert.equal(err, reason))
    // The stream is errored, not closed: another read rejects the same way.
    await expectReject(reader.read(), (err) => assert.equal(err, reason))
  })
})

test('abort before body is touched yields an errored (not null, not empty) body', async () => {
  await withServer(stallAfter(Buffer.from('x')), async (base) => {
    const controller = new AbortController()
    const res = await fetch(base, { stream: true, signal: controller.signal })
    const reason = new Error('too late')
    controller.abort(reason)
    assert.notEqual(res.body, null)
    await expectReject(res.body.getReader().read(), (err) => assert.equal(err, reason))
  })
})

test('abort mid-consume rejects the buffering accessor with the reason', async () => {
  await withServer(stallAfter(Buffer.alloc(64, 2)), async (base, server) => {
    const controller = new AbortController()
    server.on('request', () => setTimeout(() => controller.abort('basta'), 50))
    const res = await fetch(base, { stream: true, signal: controller.signal })
    await expectReject(res.text(), (err) => assert.equal(err, 'basta'))
  })
})

// ------------------------------------------- abort vs consumer cancellation

test('consumer cancel stays a clean close, never an AbortError', async () => {
  await withServer(stallAfter(Buffer.from('data')), async (base) => {
    const controller = new AbortController()
    const res = await fetch(base, { stream: true, signal: controller.signal })
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel() // resolves cleanly; no rejection anywhere
    assert.equal(res.bodyUsed, true)
  })
})

test('abort after the body is fully consumed is a no-op', async () => {
  await withServer(
    (req, res) => res.end('complete'),
    async (base) => {
      const controller = new AbortController()
      const res = await fetch(base, { stream: true, signal: controller.signal })
      assert.equal(await res.text(), 'complete')
      controller.abort() // transfer already over — nothing to reject, no crash
      assert.equal(res.bodyUsed, true)
    }
  )
})

test('abort after a completed buffered fetch is a no-op', async () => {
  await withServer(
    (req, res) => res.end('done'),
    async (base) => {
      const controller = new AbortController()
      const res = await fetch(base, { signal: controller.signal })
      controller.abort()
      // Buffered body is already in memory; reads still work.
      assert.equal(await res.text(), 'done')
    }
  )
})

// -------------------------------------------------- timeout interplay

test('AbortSignal.timeout() rejects with its TimeoutError DOMException', async () => {
  await withServer(blackHole(), async (base) => {
    await expectReject(fetch(base, { signal: AbortSignal.timeout(50) }), (err) => {
      assert.ok(err instanceof DOMException)
      assert.equal(err.name, 'TimeoutError')
    })
  })
})

test('timeoutMs still yields FetchError TIMEOUT when the signal never fires', async () => {
  await withServer(blackHole(), async (base) => {
    const controller = new AbortController()
    await assert.rejects(
      fetch(base, { signal: controller.signal, timeoutMs: 50 }),
      (err) => err instanceof FetchError && err.code === 'TIMEOUT'
    )
  })
})

// -------------------------------------------------- Request-input inheritance

test('a Request input signal is inherited; init.signal (incl. null) overrides it', async () => {
  const aborted = new AbortController()
  aborted.abort('from request')

  // Inherited: the Request's aborted signal rejects the call.
  await expectReject(fetch({ url: 'http://127.0.0.1:9/', signal: aborted.signal }), (err) => {
    assert.equal(err, 'from request')
  })

  // init.signal takes precedence over the Request's.
  const fresh = new AbortController()
  fresh.abort('from init')
  await expectReject(
    fetch({ url: 'http://127.0.0.1:9/', signal: aborted.signal }, { signal: fresh.signal }),
    (err) => assert.equal(err, 'from init')
  )

  // Explicit null disables the inherited signal entirely.
  await withServer(
    (req, res) => res.end('ok'),
    async (base) => {
      const res = await fetch({ url: base, signal: aborted.signal }, { signal: null })
      assert.equal(await res.text(), 'ok')
    }
  )
})

// -------------------------------------------------- listener lifecycle

const abortListenerCount = (signal) => getEventListeners(signal, 'abort').length

test('listener is removed after a completed buffered fetch', async () => {
  await withServer(
    (req, res) => res.end('ok'),
    async (base) => {
      const controller = new AbortController()
      await fetch(base, { signal: controller.signal })
      assert.equal(abortListenerCount(controller.signal), 0)
    }
  )
})

test('listener is removed after streaming EOF, cancel, and null-body access', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/nobody') {
        res.writeHead(204)
        res.end()
      } else {
        res.end('payload')
      }
    },
    async (base) => {
      // EOF path.
      const c1 = new AbortController()
      const r1 = await fetch(base, { stream: true, signal: c1.signal })
      await r1.text()
      assert.equal(abortListenerCount(c1.signal), 0)

      // Consumer-cancel path.
      const c2 = new AbortController()
      const r2 = await fetch(base, { stream: true, signal: c2.signal })
      await r2.cancel()
      assert.equal(abortListenerCount(c2.signal), 0)

      // Null-body path.
      const c3 = new AbortController()
      const r3 = await fetch(`${base}/nobody`, { stream: true, signal: c3.signal })
      assert.equal(r3.body, null)
      assert.equal(abortListenerCount(c3.signal), 0)
    }
  )
})

test('one long-lived signal reused across many requests leaves no listeners behind', async () => {
  await withServer(
    (req, res) => res.end('ok'),
    async (base) => {
      const controller = new AbortController()
      for (let i = 0; i < 25; i++) {
        const res = await fetch(base, { stream: i % 2 === 0, signal: controller.signal })
        await res.text()
      }
      assert.equal(abortListenerCount(controller.signal), 0)
    }
  )
})
