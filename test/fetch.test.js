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

test('fetch GET returns status, headers and json body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'hello' })
      res.end(JSON.stringify({ ok: true, method: req.method }))
    },
    async (base) => {
      const res = await fetch(`${base}/ping`)
      assert.equal(res.status, 200)
      assert.equal(res.ok, true)
      assert.equal(res.headers.get('x-custom'), 'hello')
      assert.equal(res.headers.get('X-Custom'), 'hello')
      assert.equal(res.headers.has('x-custom'), true)
      assert.deepEqual(await res.json(), { ok: true, method: 'GET' })
      assert.equal(await res.text(), JSON.stringify({ ok: true, method: 'GET' }))
    }
  )
})

test('fetch POST sends method, headers and body', async () => {
  await withServer(
    (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'text/plain' })
        res.end(`method=${req.method};auth=${req.headers['authorization']};body=${body}`)
      })
    },
    async (base) => {
      const res = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { authorization: 'Bearer token123' },
        body: 'hello-world',
      })
      assert.equal(res.status, 201)
      assert.equal(await res.text(), 'method=POST;auth=Bearer token123;body=hello-world')
    }
  )
})

test('fetch surfaces non-2xx status without throwing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    },
    async (base) => {
      const res = await fetch(`${base}/missing`)
      assert.equal(res.status, 404)
      assert.equal(res.ok, false)
      assert.equal(await res.text(), 'not found')
    }
  )
})

test('res.json() supports a .then() promise chain, not just await', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ chained: true }))
    },
    async (base) => {
      const res = await fetch(`${base}/chain`)
      const parsed = await res.json().then((data) => ({ ...data, extra: 1 }))
      assert.deepEqual(parsed, { chained: true, extra: 1 })
    }
  )
})

test('fetch follows redirects and reports redirected + final url', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('landed')
    },
    async (base) => {
      const res = await fetch(`${base}/start`)
      assert.equal(res.status, 200)
      assert.equal(res.redirected, true)
      assert.equal(res.url, `${base}/end`)
      assert.equal(await res.text(), 'landed')
    }
  )
})

test('fetch accepts an impersonate profile without throwing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
    async (base) => {
      const res = await fetch(`${base}/ping`, { impersonate: 'firefox_142' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'ok')
    }
  )
})
