const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { fetch, FetchResponse } = require('../index.js')

// Echo server: reports the received method, a chosen header, and the raw body
// bytes (as hex) so tests can assert exact round-trips.
function withEchoServer(run) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          contentType: req.headers['content-type'] || null,
          xRequestId: req.headers['x-request-id'] || null,
          bodyHex: body.toString('hex'),
          bodyText: body.toString('utf-8'),
        }),
      )
    })
  })
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

test('Uint8Array body round-trips exactly, including non-UTF-8 bytes', async () => {
  await withEchoServer(async (base) => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0xc3, 0x28, 0x41])
    const res = await fetch(`${base}/`, { method: 'POST', body: bytes })
    const echo = await res.json()
    assert.equal(echo.bodyHex, '00ff10c32841')
    assert.equal(echo.method, 'POST')
  })
})

test('Node Buffer body round-trips exactly', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, { method: 'POST', body: Buffer.from('café', 'utf-8') })
    const echo = await res.json()
    assert.equal(echo.bodyText, 'café')
  })
})

test('a typed-array view over a larger buffer sends only its own region', async () => {
  await withEchoServer(async (base) => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const view = backing.subarray(2, 5) // bytes 3,4,5
    const res = await fetch(`${base}/`, { method: 'POST', body: view })
    const echo = await res.json()
    assert.equal(echo.bodyHex, '030405')
  })
})

test('ArrayBuffer body is accepted', async () => {
  await withEchoServer(async (base) => {
    const ab = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer
    const res = await fetch(`${base}/`, { method: 'POST', body: ab })
    const echo = await res.json()
    assert.equal(echo.bodyHex, 'deadbeef')
  })
})

test('URLSearchParams body sets a default form-urlencoded content-type', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      body: new URLSearchParams({ a: '1', b: 'two words' }),
    })
    const echo = await res.json()
    assert.equal(echo.bodyText, 'a=1&b=two+words')
    assert.equal(echo.contentType, 'application/x-www-form-urlencoded;charset=UTF-8')
  })
})

test('an explicit content-type is not overridden by the body default', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-my-thing' },
      body: new URLSearchParams({ a: '1' }),
    })
    const echo = await res.json()
    assert.equal(echo.contentType, 'application/x-my-thing')
  })
})

test('Blob body sends its bytes and defaults content-type to the blob type', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, {
      method: 'POST',
      body: new Blob(['hello blob'], { type: 'text/plain;charset=utf-8' }),
    })
    const echo = await res.json()
    assert.equal(echo.bodyText, 'hello blob')
    assert.equal(echo.contentType, 'text/plain;charset=utf-8')
  })
})

test('FormData body is rejected with a clear, fingerprint-aware error', async () => {
  await withEchoServer(async (base) => {
    const fd = new FormData()
    fd.append('field', 'value')
    await assert.rejects(fetch(`${base}/`, { method: 'POST', body: fd }), /FormData\/multipart/)
  })
})

test('a Headers instance is accepted as request headers', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, { headers: new Headers({ 'x-request-id': 'via-headers' }) })
    const echo = await res.json()
    assert.equal(echo.xRequestId, 'via-headers')
  })
})

test('an array of header pairs is accepted', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, { headers: [['x-request-id', 'via-array']] })
    const echo = await res.json()
    assert.equal(echo.xRequestId, 'via-array')
  })
})

test('a URL object is accepted as input', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(new URL(`${base}/path`))
    assert.equal(res.status, 200)
    assert.equal(res.url, `${base}/path`)
  })
})

test('a Request-like input carries url, method, headers, and body', async () => {
  await withEchoServer(async (base) => {
    const request = new Request(`${base}/`, {
      method: 'PUT',
      headers: { 'x-request-id': 'via-request' },
      body: 'from-request',
    })
    const res = await fetch(request)
    const echo = await res.json()
    assert.equal(echo.method, 'PUT')
    assert.equal(echo.xRequestId, 'via-request')
    assert.equal(echo.bodyText, 'from-request')
  })
})

test('init overrides a Request-like input', async () => {
  await withEchoServer(async (base) => {
    const request = new Request(`${base}/`, { method: 'PUT', body: 'original' })
    const res = await fetch(request, { method: 'POST', body: 'overridden' })
    const echo = await res.json()
    assert.equal(echo.method, 'POST')
    assert.equal(echo.bodyText, 'overridden')
  })
})

test('a lower-case standard method is normalized to upper case', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, { method: 'post', body: 'x' })
    const echo = await res.json()
    assert.equal(echo.method, 'POST')
  })
})

test('response exposes bytes(), arrayBuffer(), blob() and WHATWG headers', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-a': '1' })
    res.end(Buffer.from([0x01, 0x02, 0x03]))
  })
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        assert.ok(res instanceof FetchResponse)

        // WHATWG Headers: iterable + get + forEach
        assert.equal(res.headers.get('x-a'), '1')
        assert.equal(res.headers.get('X-A'), '1')
        const seen = {}
        res.headers.forEach((v, k) => (seen[k] = v))
        assert.equal(seen['x-a'], '1')
        assert.ok(typeof res.rawHeaders.entries === 'function')

        const bytes = await res.bytes()
        assert.ok(bytes instanceof Uint8Array)
        assert.deepEqual([...bytes], [0x01, 0x02, 0x03])
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
})

test('bodyUsed flips after the first read, and the body stays re-readable', async () => {
  await withEchoServer(async (base) => {
    const res = await fetch(`${base}/`, { method: 'POST', body: 'abc' })
    assert.equal(res.bodyUsed, false)
    const first = await res.text()
    assert.equal(res.bodyUsed, true)
    const second = await res.json() // buffered — re-reading is allowed
    assert.equal(JSON.parse(first).bodyText, 'abc')
    assert.equal(second.bodyText, 'abc')
  })
})

test('arrayBuffer() returns a real ArrayBuffer', async () => {
  const server = http.createServer((req, res) => res.end(Buffer.from([9, 8, 7])))
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        const ab = await res.arrayBuffer()
        assert.ok(ab instanceof ArrayBuffer)
        assert.deepEqual([...new Uint8Array(ab)], [9, 8, 7])
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
})
