const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { fetch, FetchError } = require('../index.js')

// `withRefusedPort` binds an ephemeral port, captures it, then closes — so the
// port is guaranteed free, rather than relying on some "probably closed"
// well-known port.
//
// What the OS does with a connect to that port is *not* uniform, though. POSIX
// answers with an immediate RST, so wreq sees a connect failure and classifies
// it precisely. The Windows CI runners drop the SYN instead of refusing it:
// nothing comes back, the request-level `timeoutMs` fires, and the resulting
// error is a plain timeout that was never tagged as a connect failure at all —
// so it classifies as TIMEOUT.
//
// That applies to the proxy case too. When the SYN to the proxy is black-holed
// there is no proxy-connect error for `classify_request_error` to see, only the
// timeout that fired around it — so PROXY_CONNECT is not reached either.
//
// Both outcomes truthfully describe what the OS did, so widen the expectation on
// win32 rather than pretending the platforms behave alike.
const orTimeoutOnWindows = (code) => (process.platform === 'win32' ? [code, 'TIMEOUT'] : [code])

function assertCode(err, expected) {
  const acceptable = orTimeoutOnWindows(expected)
  assert.ok(err instanceof FetchError, `expected FetchError, got ${err && err.name}`)
  assert.ok(acceptable.includes(err.code), `expected ${acceptable.join(' or ')}, got ${err.code}`)
}

function withRefusedPort(run) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => {
        Promise.resolve(run(port)).then(resolve, reject)
      })
    })
  })
}

function withHttpServer(handler, run) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try {
        await run(`http://127.0.0.1:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

// A TCP server that accepts connections and then holds them open without ever
// sending a byte, so a request against it deterministically hits `timeoutMs`
// (no dependency on host routing, unlike a reserved/blackholed public IP).
function withStalledServer(run) {
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try {
        await run(port)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        for (const sock of sockets) sock.destroy()
        server.close()
      }
    })
  })
}

test('a refused proxy rejects with FetchError code PROXY_CONNECT', async () => {
  await withRefusedPort(async (port) => {
    await assert.rejects(
      fetch('https://example.com', { proxy: `http://127.0.0.1:${port}`, timeoutMs: 2000 }),
      (err) => {
        assertCode(err, 'PROXY_CONNECT')
        assert.ok(err.cause, 'native error preserved on cause')
        assert.doesNotMatch(err.message, /^\[/, 'the [CODE] tag is stripped from the message')
        return true
      }
    )
  })
})

test('a refused origin rejects with FetchError code CONNECT', async () => {
  await withRefusedPort(async (port) => {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 }), (err) => {
      assertCode(err, 'CONNECT')
      return true
    })
  })
})

test('a server that accepts then stalls rejects with FetchError code TIMEOUT', async () => {
  // The server accepts the TCP connection but never responds, so `timeoutMs`
  // elapses while awaiting the response. TIMEOUT is stage-agnostic (it can fire
  // at any point), so this pins the code, not the stage.
  await withStalledServer(async (port) => {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { timeoutMs: 300 }), (err) => {
      assert.ok(err instanceof FetchError, `expected FetchError, got ${err && err.name}`)
      assert.equal(err.code, 'TIMEOUT')
      return true
    })
  })
})

test('a TLS handshake failure rejects with FetchError code CONNECT (no separate TLS code)', async () => {
  // HTTPS request to a plain-HTTP server: the server replies to the ClientHello
  // with non-TLS bytes, so BoringSSL aborts with WRONG_VERSION_NUMBER. wreq
  // wraps that handshake error as a connector Connect error, so it is reported
  // as CONNECT, not a dedicated TLS code. Fully local and deterministic.
  await withHttpServer(
    (req, res) => res.end('ok'),
    async (base) => {
      const httpsUrl = base.replace(/^http:/, 'https:')
      await assert.rejects(fetch(`${httpsUrl}/`, { timeoutMs: 2000 }), (err) => {
        assert.ok(err instanceof FetchError, `expected FetchError, got ${err && err.name}`)
        assert.equal(err.code, 'CONNECT')
        return true
      })
    }
  )
})

test('exceeding maxResponseBytes rejects with FetchError code RESPONSE_TOO_LARGE', async () => {
  await withHttpServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(10000))
    },
    async (base) => {
      await assert.rejects(fetch(base, { maxResponseBytes: 100 }), (err) => {
        assert.ok(err instanceof FetchError, `expected FetchError, got ${err && err.name}`)
        assert.equal(err.code, 'RESPONSE_TOO_LARGE')
        return true
      })
    }
  )
})

test('setting both resolve and proxy emits the MYFETCH_RESOLVE_IGNORED warning exactly once', async () => {
  await withRefusedPort(async (port) => {
    const warnings = []
    const onWarn = (w) => warnings.push(w)
    process.on('warning', onWarn)
    try {
      // Two both-set requests: the warning must fire on the first and stay quiet
      // on the second, or the module-level dedup flag is broken.
      for (let i = 0; i < 2; i++) {
        await fetch('https://example.com', {
          proxy: `http://127.0.0.1:${port}`,
          resolve: { 'example.com': ['127.0.0.1'] },
          timeoutMs: 2000,
        }).catch(() => {})
      }
      // emitWarning fires on a later tick; let the microtask/timer queue drain.
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('warning', onWarn)
    }
    const resolveWarnings = warnings.filter((w) => w.code === 'MYFETCH_RESOLVE_IGNORED')
    assert.equal(resolveWarnings.length, 1, 'expected exactly one MYFETCH_RESOLVE_IGNORED warning')
  })
})
