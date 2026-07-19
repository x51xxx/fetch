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

test('redirect manual returns the 3xx response without issuing the next request', async () => {
  let requests = 0
  await withServer(
    (req, res) => {
      requests += 1
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' })
        res.end('redirect body')
        return
      }
      res.writeHead(200)
      res.end('should not be reached')
    },
    async (base) => {
      const res = await fetch(`${base}/start`, { redirect: 'manual' })
      assert.equal(res.status, 302)
      assert.equal(res.redirected, false)
      assert.equal(res.url, `${base}/start`)
      assert.equal(res.headers.get('location'), '/end')
      assert.equal(await res.text(), 'redirect body')
      assert.equal(requests, 1)
    }
  )
})

test('redirect error rejects on a redirect', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { location: '/end' })
      res.end()
    },
    async (base) => {
      await assert.rejects(fetch(`${base}/start`, { redirect: 'error' }), /redirect/i)
    }
  )
})

test('fetch honors redirect carried by a Request input, with init taking precedence', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('followed')
    },
    async (base) => {
      const manual = await fetch(new Request(`${base}/start`, { redirect: 'manual' }))
      assert.equal(manual.status, 302)
      assert.equal(manual.headers.get('location'), '/end')

      const overridden = await fetch(new Request(`${base}/start`, { redirect: 'manual' }), {
        redirect: 'follow',
      })
      assert.equal(overridden.status, 200)
      assert.equal(await overridden.text(), 'followed')
    }
  )
})

test('one session keeps one cookie jar across redirect modes', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/login') {
        res.writeHead(302, { 'set-cookie': 'sid=jar-proof; Path=/', location: '/after' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end(req.headers.cookie || '')
    },
    async (base) => {
      const session = `redirect-modes-share-jar-${process.pid}`
      const login = await fetch(`${base}/login`, { session, redirect: 'manual' })
      assert.equal(login.status, 302)
      const res = await fetch(`${base}/whoami`, { session })
      assert.equal(await res.text(), 'sid=jar-proof')
    }
  )
})

test('session + resolve shares the session cookie jar with cached clients', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=pinned-set; Path=/' })
        res.end('ok')
        return
      }
      res.writeHead(200)
      res.end(req.headers.cookie || '')
    },
    async (base) => {
      const session = `resolve-shared-jar-${process.pid}`
      // A resolve map with no matching entry still routes the call through a
      // one-off client — the cookie it stores must land in the session's jar.
      const oneOff = { resolve: { 'unmatched.test': '203.0.113.1' } }
      await fetch(`${base}/set`, { session, ...oneOff })
      const cached = await fetch(`${base}/check`, { session })
      assert.equal(await cached.text(), 'sid=pinned-set')
      // And the reverse direction: a later one-off client sees the jar too.
      const pinned = await fetch(`${base}/check`, { session, ...oneOff })
      assert.equal(await pinned.text(), 'sid=pinned-set')
    }
  )
})

test('cookies persist across pinned requests within one session', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=pin-persist; Path=/' })
        res.end('ok')
        return
      }
      res.writeHead(200)
      res.end(req.headers.cookie || '')
    },
    async (base) => {
      const port = new URL(base).port
      const session = `pin-cookie-persist-${process.pid}`
      const target = `http://cookie-pin.test:${port}`
      const pin = { 'cookie-pin.test': '127.0.0.1' }
      await fetch(`${target}/set`, { session, resolve: pin })
      const res = await fetch(`${target}/check`, { session, resolve: pin })
      assert.equal(await res.text(), 'sid=pin-persist')
    }
  )
})

test('resolve pins the socket while preserving the original Host header', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(req.headers.host)
    },
    async (base) => {
      const port = new URL(base).port
      const hostname = 'pinned.test'
      await assert.rejects(
        fetch(`http://${hostname}:${port}/pin`, { timeoutMs: 1000 }),
        /request failed/
      )
      const res = await fetch(`http://${hostname}:${port}/pin`, {
        resolve: { [`${hostname}:${port}`]: ['127.0.0.1'] },
        redirect: 'manual',
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), `${hostname}:${port}`)
    }
  )
})

test('resolve supports a single-IP host-only entry', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200)
      res.end('pinned')
    },
    async (base) => {
      const port = new URL(base).port
      const res = await fetch(`http://single-pin.test:${port}/`, {
        resolve: { 'single-pin.test': '127.0.0.1' },
      })
      assert.equal(await res.text(), 'pinned')
    }
  )
})

test('resolve prefers host:port and accepts multiple IPs', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200)
      res.end('port-specific pin')
    },
    async (base) => {
      const port = new URL(base).port
      const hostname = 'resolve-precedence.test'
      const res = await fetch(`http://${hostname}:${port}/`, {
        resolve: {
          [hostname]: 'not-used-because-port-specific-wins',
          [`${hostname}:${port}`]: ['127.0.0.1', '127.0.0.2'],
        },
      })
      assert.equal(await res.text(), 'port-specific pin')
    }
  )
})

test('resolve ignores entries that do not match the request host', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200)
      res.end('normal resolution')
    },
    async (base) => {
      const res = await fetch(`${base}/`, {
        resolve: { 'stale-map-entry.test': 'not-an-ip' },
      })
      assert.equal(await res.text(), 'normal resolution')
    }
  )
})

test('resolve rejects the request when the selected pin cannot connect', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200)
      res.end('must not connect')
    },
    async (base) => {
      const port = new URL(base).port
      await assert.rejects(
        fetch(`http://wrong-pin.test:${port}/`, {
          resolve: { 'wrong-pin.test': '127.0.0.2' },
          timeoutMs: 1000,
        })
      )
    }
  )
})

test('resolve does not install pins for cross-host redirect targets', async () => {
  let requests = 0
  await withServer(
    (req, res) => {
      requests += 1
      const port = req.headers.host.split(':').at(-1)
      res.writeHead(302, { location: `http://redirect-pin.test:${port}/end` })
      res.end()
    },
    async (base) => {
      const port = new URL(base).port
      await assert.rejects(
        fetch(`http://initial-pin.test:${port}/start`, {
          resolve: {
            'initial-pin.test': '127.0.0.1',
            'redirect-pin.test': '127.0.0.1',
          },
          timeoutMs: 2000,
        })
      )
      assert.equal(requests, 1)
    }
  )
})

test('redirect and resolve reject unsupported or malformed values', async () => {
  await assert.rejects(fetch('http://127.0.0.1/', { redirect: 'sideways' }), /unsupported redirect/)
  await assert.rejects(
    fetch('http://127.0.0.1/', { resolve: { '127.0.0.1': 'not-an-ip' } }),
    /invalid IP address/
  )
  await assert.rejects(
    fetch('https://[2001:db8::1]:8443/', {
      resolve: { '[2001:db8::1]:8443': 'not-an-ip' },
    }),
    /invalid IP address/
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
