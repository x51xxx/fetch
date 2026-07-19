const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { clearSession, fetch } = require('../index.js')

function withServer(handler, run) {
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

test('session carries cookies across calls like a real browser tab', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=abc123; Path=/' })
        res.end('set')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`cookie=${req.headers.cookie || ''}`)
    },
    async (base) => {
      const session = `test-session-${process.pid}`
      await fetch(`${base}/set`, { session })
      const res = await fetch(`${base}/check`, { session })
      assert.equal(await res.text(), 'cookie=sid=abc123')
    }
  )
})

test('calls without a session never share cookies with each other', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=should-not-leak; Path=/' })
        res.end('set')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`cookie=${req.headers.cookie || 'none'}`)
    },
    async (base) => {
      await fetch(`${base}/set`, { impersonate: 'chrome_147' })
      const res = await fetch(`${base}/check`, { impersonate: 'chrome_147' })
      assert.equal(await res.text(), 'cookie=none')
    }
  )
})

test('two different sessions get isolated cookie jars', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/set/')) {
        const value = req.url.split('/set/')[1]
        res.writeHead(200, { 'set-cookie': `sid=${value}; Path=/` })
        res.end('set')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`cookie=${req.headers.cookie || 'none'}`)
    },
    async (base) => {
      const sessionA = `session-a-${process.pid}`
      const sessionB = `session-b-${process.pid}`
      await fetch(`${base}/set/alice`, { session: sessionA })
      await fetch(`${base}/set/bob`, { session: sessionB })

      const resA = await fetch(`${base}/check`, { session: sessionA })
      const resB = await fetch(`${base}/check`, { session: sessionB })
      assert.equal(await resA.text(), 'cookie=sid=alice')
      assert.equal(await resB.text(), 'cookie=sid=bob')
    }
  )
})

test('one session shares its cookie jar across impersonate profiles', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=cross-profile; Path=/' })
        res.end('set')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`cookie=${req.headers.cookie || 'none'}`)
    },
    async (base) => {
      // Distinct impersonate values mean distinct cached clients, but the
      // jar is keyed by the session id alone — like one browser tab whose
      // fingerprint settings changed mid-session.
      const session = `cross-profile-jar-${process.pid}`
      await fetch(`${base}/set`, { session, impersonate: 'chrome_147' })
      const res = await fetch(`${base}/check`, { session, impersonate: 'firefox_142' })
      assert.equal(await res.text(), 'cookie=sid=cross-profile')
    }
  )
})

test('clearSession drops a session cookie jar', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=clear-me; Path=/' })
        res.end('set')
        return
      }
      res.end(req.headers.cookie || 'none')
    },
    async (base) => {
      const session = `clear-session-${process.pid}`
      await fetch(`${base}/set`, { session })
      assert.equal(clearSession(session), 1)
      const res = await fetch(`${base}/check`, { session })
      assert.equal(await res.text(), 'none')
    }
  )
})

test('timeoutMs aborts a request to a slow server', async () => {
  await withServer(
    (req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('too slow')
      }, 2000)
    },
    async (base) => {
      await assert.rejects(fetch(`${base}/slow`, { timeoutMs: 100 }))
    }
  )
})

test('maxResponseBytes rejects a response before it can grow unbounded', async () => {
  await withServer(
    (req, res) => {
      res.end('x'.repeat(64))
    },
    async (base) => {
      await assert.rejects(fetch(`${base}/large`, { maxResponseBytes: 16 }), /maxResponseBytes/)
    }
  )
})

test('case-only duplicate request headers are combined (WHATWG), not rejected', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(String(req.headers['x-request-id']))
    },
    async (base) => {
      // The wrapper folds case-insensitive duplicates the way `Headers` does,
      // so the native layer never sees an ambiguous repeated header.
      const res = await fetch(`${base}/headers`, {
        headers: { 'x-request-id': 'one', 'X-Request-Id': 'two' },
      })
      assert.equal(await res.text(), 'one, two')
    }
  )
})

test('an invalid tlsMinVersion is rejected with a clear error', async () => {
  await assert.rejects(
    fetch('https://example.com', { session: `bad-tls-${process.pid}`, tlsMinVersion: '9.9' }),
    /tlsMinVersion|tlsMaxVersion|9\.9/
  )
})

test('an invalid httpVersion is rejected with a clear error', async () => {
  await assert.rejects(
    fetch('https://example.com', { session: `bad-http-${process.pid}`, httpVersion: 'http/3' }),
    /httpVersion/
  )
})

test('an invalid proxy URL is rejected with a clear error', async () => {
  await assert.rejects(fetch('https://example.com', { proxy: 'not a url' }))
})

test('platform overrides the declared OS in headers without changing impersonate', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          userAgent: req.headers['user-agent'],
          secChUaPlatform: req.headers['sec-ch-ua-platform'],
        })
      )
    },
    async (base) => {
      const macos = await fetch(base, { impersonate: 'chrome_147' })
      const linux = await fetch(base, { impersonate: 'chrome_147', platform: 'linux' })

      const macosBody = await macos.json()
      const linuxBody = await linux.json()

      assert.match(macosBody.userAgent, /Macintosh/)
      assert.match(linuxBody.userAgent, /X11; Linux/)
      assert.match(linuxBody.secChUaPlatform, /Linux/)
    }
  )
})

test('an invalid platform is rejected with a clear error', async () => {
  await assert.rejects(
    fetch('https://example.com', { session: `bad-platform-${process.pid}`, platform: 'amiga' }),
    /platform/
  )
})
