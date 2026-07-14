const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
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

// `bytes()` returns a view over the native Buffer instead of copying it. That
// is only sound while each native read hands back its own allocation, so these
// pin the observable contract: separate calls must not share storage, and a
// caller mutating what it got back must not corrupt the response.
test('bytes() returns independent buffers that do not alias each other', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([1, 2, 3, 4]))
    },
    async (base) => {
      const res = await fetch(base)
      const a = await res.bytes()
      const b = await res.bytes()

      assert.deepEqual([...a], [1, 2, 3, 4])
      assert.deepEqual([...b], [1, 2, 3, 4])

      a[0] = 99
      assert.equal(b[0], 1, 'mutating one bytes() result must not affect another')
    }
  )
})

test('mutating bytes() does not corrupt other accessors', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    },
    async (base) => {
      const res = await fetch(base)
      const bytes = await res.bytes()
      bytes[0] = 'J'.charCodeAt(0)

      assert.equal(await res.text(), 'hello', 'text() must not see the mutation')
      const fresh = await res.bytes()
      assert.equal(fresh[0], 'h'.charCodeAt(0))
    }
  )
})

test('bytes() covers exactly the body, not the whole backing store', async () => {
  const payload = Buffer.alloc(70000, 7)
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
    },
    async (base) => {
      const res = await fetch(base)
      const bytes = await res.bytes()
      assert.equal(bytes.byteLength, payload.length)
      assert.ok(bytes.every((b) => b === 7))
    }
  )
})

// WHATWG: reusing a Request whose body was already read is a TypeError. The
// wrapper previously dropped the body and sent a bodyless request instead.
test('fetch(Request) with an already-used body throws TypeError', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200)
      res.end('should not be reached')
    },
    async (base) => {
      const request = new Request(base, { method: 'POST', body: 'payload' })
      await request.text() // disturb the body
      assert.equal(request.bodyUsed, true)

      await assert.rejects(() => fetch(request), TypeError)
    }
  )
})

test('an explicit init.body overrides a used Request body without throwing', async () => {
  await withServer(
    (req, res) => {
      let received = ''
      req.on('data', (c) => (received += c))
      req.on('end', () => {
        res.writeHead(200)
        res.end(received)
      })
    },
    async (base) => {
      const request = new Request(base, { method: 'POST', body: 'stale' })
      await request.text()

      const res = await fetch(request, { body: 'fresh' })
      assert.equal(await res.text(), 'fresh')
    }
  )
})

test('an unused Request body is still sent', async () => {
  await withServer(
    (req, res) => {
      let received = ''
      req.on('data', (c) => (received += c))
      req.on('end', () => {
        res.writeHead(200)
        res.end(received)
      })
    },
    async (base) => {
      const request = new Request(base, { method: 'POST', body: 'payload' })
      const res = await fetch(request)
      assert.equal(await res.text(), 'payload')
    }
  )
})

// Content-Length is attacker-controlled, so it must never size an allocation.
// Feeding it straight to Vec::with_capacity is not a catchable error: Rust's
// allocation failure path aborts the process (SIGABRT), so a hostile server
// could kill the host app outright. Runs in a child process precisely because
// an abort would take this runner down with it -- an in-process assertion
// could not observe the failure it is looking for.
//
// The value matters: ~8 GB quietly succeeds on macOS (virtual overcommit, RSS
// stays low), so it would not discriminate. This one is past what any
// allocator can back, which is what makes the naive form abort.
test('a hostile Content-Length cannot abort the process', () => {
  const indexPath = require.resolve('../index.js')
  const child = `
    const http = require('node:http')
    const { fetch } = require(${JSON.stringify(indexPath)})
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': '999999999999999' })
      res.end('x')
    })
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      try { await fetch('http://127.0.0.1:' + port, { timeoutMs: 3000 }) } catch {}
      server.close()
      process.exit(0)
    })
  `
  const res = spawnSync(process.execPath, ['-e', child], { timeout: 30000, encoding: 'utf8' })

  assert.notEqual(res.signal, 'SIGABRT', 'allocating from Content-Length aborted the process')
  assert.ok(
    !/memory allocation of \d+ bytes failed/.test(res.stderr || ''),
    `child hit an allocation failure:\n${res.stderr}`
  )
  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`)
})
