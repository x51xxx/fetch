'use strict'

// `resolve`-pinned requests reuse a pooled client per (client settings, URL
// host, validated address set). Observed from the server side by counting TCP
// connections: a reused client shows up as *no* new connection.
//
// Hostnames use the reserved `.test` TLD, which never resolves, so a request
// that silently lost its pin fails loudly instead of reaching some other host.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { fetch, clearSession } = require('../index.js')

async function withCountingServer(handler, run) {
  const server = http.createServer(handler)
  // Default is 5 s; the churn test below keeps early sockets idle for longer.
  server.keepAliveTimeout = 60_000
  let connections = 0
  server.on('connection', () => {
    connections += 1
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(port, () => connections)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const ok = (req, res) => {
  res.writeHead(200)
  res.end(req.headers.cookie || 'ok')
}

async function get(url, init) {
  const res = await fetch(url, init)
  assert.equal(res.status, 200)
  return res.text()
}

test('two requests with the same pin reuse one connection', async () => {
  await withCountingServer(ok, async (port, connections) => {
    const url = `http://pool-same.test:${port}/`
    await get(url, { resolve: { 'pool-same.test': '127.0.0.1' } })
    await get(url, { resolve: { 'pool-same.test': '127.0.0.1' } })
    assert.equal(connections(), 1)
    // Same address set spelled differently (duplicates, host:port key) is the
    // same pin, so still the same client.
    await get(url, { resolve: { [`pool-same.test:${port}`]: ['127.0.0.1', '127.0.0.1'] } })
    assert.equal(connections(), 1)
  })
})

test('a different address set or host never shares a pooled connection', async () => {
  await withCountingServer(ok, async (port, connections) => {
    const url = `http://pool-diff.test:${port}/`
    await get(url, { resolve: { 'pool-diff.test': '127.0.0.1' } })
    assert.equal(connections(), 1)
    // Superset of the first set -> a different client. (127.0.0.1 sorts
    // first, so the new connection lands on the listening socket.)
    await get(url, { resolve: { 'pool-diff.test': ['127.0.0.1', '::1'] } })
    assert.equal(connections(), 2)
    // Same set, other order -> the second client again.
    await get(url, { resolve: { 'pool-diff.test': ['::1', '127.0.0.1'] } })
    assert.equal(connections(), 2)
    // Another hostname pinned to the same address -> its own client.
    await get(`http://pool-other.test:${port}/`, { resolve: { 'pool-other.test': '127.0.0.1' } })
    assert.equal(connections(), 3)
  })
})

test('host spellings that differ only in case each keep their pin', async () => {
  // The pin key is not case-folded (wreq matches the override by the exact
  // URI host string). Both spellings must connect through the pin.
  await withCountingServer(ok, async (port, connections) => {
    const resolve = { 'pool-case.test': '127.0.0.1' }
    await get(`http://POOL-Case.test:${port}/`, { resolve, timeoutMs: 2000 })
    await get(`http://pool-case.test:${port}/`, { resolve, timeoutMs: 2000 })
    await get(`http://POOL-Case.test:${port}/`, { resolve, timeoutMs: 2000 })
    assert.equal(connections(), 2)
  })
})

test('pinned churn across many hosts does not evict an unpinned session client', async () => {
  await withCountingServer(ok, async (port, connections) => {
    const session = `pinned-churn-${process.pid}`
    const unpinned = `http://127.0.0.1:${port}/`
    await get(unpinned, { session })
    assert.equal(connections(), 1)

    // More distinct pinned hosts than the unpinned LRU holds (256): if pinned
    // clients shared that LRU, the session client above would be evicted.
    const hosts = 300
    for (let i = 0; i < hosts; i += 1) {
      const host = `churn-${i}.test`
      await get(`http://${host}:${port}/`, { resolve: { [host]: '127.0.0.1' } })
    }
    assert.equal(connections(), 1 + hosts)

    await get(unpinned, { session })
    assert.equal(connections(), 1 + hosts, 'the session client kept its warm connection')
  })
})

test('clearSession drops pinned clients and their cookies too', async () => {
  await withCountingServer(
    (req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'sid=pinned-clear; Path=/' })
        res.end('ok')
        return
      }
      ok(req, res)
    },
    async (port, connections) => {
      const session = `pinned-clear-${process.pid}`
      const init = { session, resolve: { 'pool-clear.test': '127.0.0.1' } }
      const base = `http://pool-clear.test:${port}`
      await get(`${base}/set`, init)
      assert.equal(await get(`${base}/check`, init), 'sid=pinned-clear')
      assert.equal(connections(), 1)

      assert.ok(clearSession(session) >= 1)
      // A pinned client left behind would still hold the old cookie jar.
      assert.equal(await get(`${base}/check`, init), 'ok')
      assert.equal(connections(), 2)
    }
  )
})
