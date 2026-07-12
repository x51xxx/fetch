const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { fetch } = require('../index.js')

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
