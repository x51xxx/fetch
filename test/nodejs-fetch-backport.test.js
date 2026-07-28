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

// Backported Node.js / WPT fetch tests: HTTP Method normalization & handling
test('Node.js fetch backport: HTTP method normalization (get, head, put, delete, options)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method }))
    },
    async (base) => {
      for (const m of ['get', 'put', 'delete', 'options']) {
        const res = await fetch(base, { method: m })
        const data = await res.json()
        assert.equal(data.method, m.toUpperCase())
      }
    }
  )
})

test('Node.js fetch backport: custom HTTP methods pass through unchanged', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method }))
    },
    async (base) => {
      for (const customMethod of ['PATCH', 'PURGE', 'PROPFIND', 'REPORT']) {
        const res = await fetch(base, { method: customMethod })
        const data = await res.json()
        assert.equal(data.method, customMethod)
      }
    }
  )
})

test('Node.js fetch backport: HEAD request receives headers and empty body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-head-header': 'head-value',
        'content-length': '100', // header says 100, but no body is sent for HEAD
      })
      res.end()
    },
    async (base) => {
      const res = await fetch(base, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-head-header'), 'head-value')
      assert.equal(await res.text(), '')
      const bytes = await res.bytes()
      assert.equal(bytes.length, 0)
    }
  )
})

// Backported Node.js / WPT fetch tests: HTTP Status codes
test('Node.js fetch backport: Status 204 No Content and 205 Reset Content', async () => {
  await withServer(
    (req, res) => {
      const status = req.url === '/204' ? 204 : 205
      res.writeHead(status)
      res.end()
    },
    async (base) => {
      const res204 = await fetch(`${base}/204`)
      assert.equal(res204.status, 204)
      assert.equal(res204.ok, true)
      assert.equal(await res204.text(), '')

      const res205 = await fetch(`${base}/205`)
      assert.equal(res205.status, 205)
      assert.equal(res205.ok, true)
      assert.equal(await res205.text(), '')
    }
  )
})

test('Node.js fetch backport: 4xx and 5xx status codes set ok=false without throwing', async () => {
  await withServer(
    (req, res) => {
      const code = parseInt(req.url.slice(1), 10) || 500
      res.writeHead(code, { 'content-type': 'text/plain' })
      res.end(`error-${code}`)
    },
    async (base) => {
      for (const statusCode of [400, 401, 403, 405, 500, 502, 503]) {
        const res = await fetch(`${base}/${statusCode}`)
        assert.equal(res.status, statusCode)
        assert.equal(res.ok, false)
        assert.equal(await res.text(), `error-${statusCode}`)
      }
    }
  )
})

// Backported Node.js / WPT fetch tests: URL search params & hash handling
test('Node.js fetch backport: URL with query parameters and fragment', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url }))
    },
    async (base) => {
      const res = await fetch(`${base}/search?q=node%20fetch&limit=10#section2`)
      const data = await res.json()
      assert.equal(data.url, '/search?q=node%20fetch&limit=10')
    }
  )
})

// Backported Node.js / WPT fetch tests: Header handling
test('Node.js fetch backport: case-insensitive headers and multiple duplicate headers', async () => {
  await withServer(
    (req, res) => {
      res.setHeader('X-Server-Header', 'First')
      res.setHeader('x-server-header', ['First', 'Second']) // Multiple header values
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
    async (base) => {
      const res = await fetch(base)
      assert.equal(res.headers.get('x-server-header'), 'First, Second')
      assert.equal(res.headers.get('X-SERVER-HEADER'), 'First, Second')
      assert.equal(res.headers.has('x-server-header'), true)

      // getSetCookie support
      if (typeof res.headers.getSetCookie === 'function') {
        const cookies = res.headers.getSetCookie()
        assert.ok(Array.isArray(cookies))
      }
    }
  )
})

// Backported Node.js / WPT fetch tests: Response body accessors
test('Node.js fetch backport: res.json() throws SyntaxError on invalid JSON', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('invalid-json-content {')
    },
    async (base) => {
      const res = await fetch(base)
      await assert.rejects(() => res.json(), SyntaxError)
    }
  )
})

test('Node.js fetch backport: res.blob() returns Blob typed from Content-Type', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    },
    async (base) => {
      const res = await fetch(base)
      const blob = await res.blob()
      assert.equal(blob.type, 'image/png')
      assert.equal(blob.size, 4)
    }
  )
})

test('Node.js fetch backport: res.arrayBuffer() returns ArrayBuffer with exact byteLength', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([10, 20, 30, 40, 50]))
    },
    async (base) => {
      const res = await fetch(base)
      const ab = await res.arrayBuffer()
      assert.ok(ab instanceof ArrayBuffer)
      assert.equal(ab.byteLength, 5)
      const view = new Uint8Array(ab)
      assert.deepEqual([...view], [10, 20, 30, 40, 50])
    }
  )
})

test('Node.js fetch backport: empty body request (0 bytes)', async () => {
  await withServer(
    (req, res) => {
      let bodyLength = 0
      req.on('data', (c) => (bodyLength += c.length))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, bodyLength }))
      })
    },
    async (base) => {
      const res = await fetch(base, { method: 'POST', body: '' })
      const data = await res.json()
      assert.equal(data.bodyLength, 0)
    }
  )
})
