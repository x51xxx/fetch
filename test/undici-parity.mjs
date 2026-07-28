// Differential harness: runs identical scenarios against Node's built-in undici
// fetch and @trishchuk/fetch, and reports where observable behaviour differs.
import http from 'node:http'
import { createRequire } from 'node:module'

// Deliberately NOT a *.test.js file: `npm test` runs `node --test test/*.test.js`,
// and this harness reports divergences rather than asserting them. Run it directly:
//   node test/undici-parity.mjs
const require = createRequire(import.meta.url)
const mine = require('../index.js').fetch

const IMPLS = [
  ['undici', globalThis.fetch],
  ['mine', mine],
  ['mine-stream', (u, i) => mine(u, { ...i, stream: true })],
]

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`
      try {
        resolve(await run(base))
      } catch (e) {
        reject(e)
      } finally {
        server.close()
      }
    })
  })
}

const results = []
async function probe(name, handler, run) {
  const row = { name }
  for (const [label, impl] of IMPLS) {
    try {
      row[label] = await withServer(handler, (base) => run(impl, base))
    } catch (e) {
      row[label] = `THREW: ${e.constructor.name}: ${String(e.message).slice(0, 90)}`
    }
  }
  row.same = JSON.stringify(row.undici) === JSON.stringify(row.mine)
  row.sameStream = JSON.stringify(row.undici) === JSON.stringify(row['mine-stream'])
  results.push(row)
}

const ok =
  (body, headers = {}) =>
  (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', ...headers })
    res.end(body)
  }

// ---- scenarios -------------------------------------------------------------

await probe('headers: case-insensitive get', ok('hi', { 'X-Weird-Case': 'v' }), async (f, base) => {
  const r = await f(base)
  return [r.headers.get('x-weird-case'), r.headers.get('X-WEIRD-CASE')]
})

await probe(
  'headers: getSetCookie()',
  (req, res) => {
    res.writeHead(200, { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] })
    res.end('x')
  },
  async (f, base) => {
    const r = await f(base)
    return r.headers.getSetCookie()
  }
)

await probe(
  'headers: duplicate non-cookie combined',
  (req, res) => {
    res.writeHead(200, { 'X-Multi': ['one', 'two'] })
    res.end('x')
  },
  async (f, base) => (await f(base)).headers.get('x-multi')
)

await probe(
  '204: status + body text',
  (req, res) => {
    res.writeHead(204)
    res.end()
  },
  async (f, base) => {
    const r = await f(base)
    return [r.status, r.ok, await r.text(), r.body === null]
  }
)

await probe(
  'method normalization: lowercase get',
  (req, res) => {
    res.writeHead(200)
    res.end(req.method)
  },
  async (f, base) => (await f(base, { method: 'get' })).text()
)

await probe(
  'method: custom verb kept',
  (req, res) => {
    res.writeHead(200)
    res.end(req.method)
  },
  async (f, base) => (await f(base, { method: 'PATCH' })).text()
)

await probe(
  'redirect: url + redirected',
  (req, res) => {
    if (req.url === '/from') {
      res.writeHead(302, { Location: '/to' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('arrived')
    }
  },
  async (f, base) => {
    const r = await f(`${base}/from`)
    return [r.redirected, r.url.endsWith('/to'), await r.text()]
  }
)

await probe(
  'redirect: manual',
  (req, res) => {
    if (req.url === '/from') {
      res.writeHead(302, { Location: '/to' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('arrived')
    }
  },
  async (f, base) => {
    const r = await f(`${base}/from`, { redirect: 'manual' })
    return [r.status, r.redirected, r.headers.get('location')]
  }
)

await probe('bodyUsed + double read', ok('hello'), async (f, base) => {
  const r = await f(base)
  const before = r.bodyUsed
  const first = await r.text()
  const after = r.bodyUsed
  let second
  try {
    second = await r.text()
  } catch (e) {
    second = `THREW:${e.constructor.name}`
  }
  return [before, first, after, second]
})

await probe(
  'statusText',
  (req, res) => {
    res.writeHead(404, 'Not Found')
    res.end('x')
  },
  async (f, base) => {
    const r = await f(base)
    return [r.status, r.statusText, r.ok]
  }
)

await probe(
  'json()',
  ok(JSON.stringify({ a: 1 }), { 'content-type': 'application/json' }),
  async (f, base) => (await f(base)).json()
)

await probe(
  'empty body: text()',
  (req, res) => {
    res.writeHead(200, { 'content-length': '0' })
    res.end()
  },
  async (f, base) => {
    const r = await f(base)
    return [await r.text(), r.status]
  }
)

await probe(
  'gzip transparent decode',
  (req, res) => {
    const zlib = require('node:zlib')
    const buf = zlib.gzipSync(Buffer.from('compressed payload'))
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': buf.length })
    res.end(buf)
  },
  async (f, base) => (await f(base)).text()
)

await probe(
  'POST string body echoed',
  (req, res) => {
    let d = ''
    req.on('data', (c) => {
      d += c
    })
    req.on('end', () => {
      res.writeHead(200)
      res.end(d)
    })
  },
  async (f, base) => (await f(base, { method: 'POST', body: 'payload' })).text()
)

await probe('response.body is ReadableStream', ok('stream me'), async (f, base) => {
  const r = await f(base)
  return [r.body === null ? 'null' : (r.body?.constructor?.name ?? typeof r.body)]
})

await probe('arrayBuffer() byteLength', ok('12345'), async (f, base) => {
  const r = await f(base)
  return (await r.arrayBuffer()).byteLength
})

await probe('bytes() type', ok('abc'), async (f, base) => {
  const r = await f(base)
  const b = await r.bytes()
  return [b.constructor.name, Array.from(b)]
})

await probe('clone()', ok('cloneme'), async (f, base) => {
  const r = await f(base)
  if (typeof r.clone !== 'function') return 'NO clone() METHOD'
  const c = r.clone()
  return [await r.text(), await c.text()]
})

// ---- report ----------------------------------------------------------------
const j = (v) => JSON.stringify(v)
console.log('\n' + '='.repeat(100))
console.log('DIFFERENTIAL PARITY: Node undici fetch  vs  @trishchuk/fetch (buffered and streaming)')
console.log('='.repeat(100))
const tag = (okv) => (okv ? '✅' : '❌')
for (const r of results) {
  console.log(`\n${tag(r.same)} buffered   ${tag(r.sameStream)} stream    ${r.name}`)
  if (!r.same || !r.sameStream) {
    console.log(`      undici      : ${j(r.undici)}`)
    console.log(`      mine        : ${j(r.mine)}`)
    console.log(`      mine-stream : ${j(r['mine-stream'])}`)
  } else {
    console.log(`      all three   : ${j(r.undici)}`)
  }
}
const diffs = results.filter((r) => !r.same)
const sdiffs = results.filter((r) => !r.sameStream)
console.log('\n' + '='.repeat(100))
console.log(`TOTAL ${results.length} scenarios`)
console.log(`  buffered vs undici : SAME ${results.length - diffs.length} | DIFF ${diffs.length}`)
console.log(`  stream   vs undici : SAME ${results.length - sdiffs.length} | DIFF ${sdiffs.length}`)
console.log('='.repeat(100))
