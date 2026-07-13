const http = require('node:http')

const PORT = Number(process.env.PORT || 9401)
const HOST = process.env.HOST || '127.0.0.1'
const UPSTREAM = process.env.UPSTREAM_URL || 'http://127.0.0.1:9301'
const CLIENT = process.env.CLIENT || 'native' // 'native' | 'wreq'
const IMPERSONATE = process.env.IMPERSONATE || 'chrome_147'
const SESSION = process.env.GATEWAY_SESSION || 'bench-gateway'

let wreqFetch = null
if (CLIENT === 'wreq') {
  wreqFetch = require('../index.js').fetch
}

async function forwardNative(targetUrl) {
  const res = await fetch(targetUrl)
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, buf }
}

async function forwardWreq(targetUrl) {
  const res = await wreqFetch(targetUrl, {
    impersonate: IMPERSONATE,
    session: SESSION,
  })
  const buf = await res.arrayBuffer()
  return { status: res.status, buf: Buffer.from(buf) }
}

const forward = CLIENT === 'wreq' ? forwardWreq : forwardNative

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }
  const targetUrl = `${UPSTREAM}${req.url}`
  const start = process.hrtime.bigint()
  try {
    const { status, buf } = await forward(targetUrl)
    const upstreamMs = Number(process.hrtime.bigint() - start) / 1e6
    res.writeHead(status, {
      'content-type': 'application/octet-stream',
      'content-length': buf.length,
      'x-upstream-ms': upstreamMs.toFixed(3),
      'x-client': CLIENT,
    })
    res.end(buf)
  } catch (err) {
    const upstreamMs = Number(process.hrtime.bigint() - start) / 1e6
    res.writeHead(502, {
      'content-type': 'application/json',
      'x-upstream-ms': upstreamMs.toFixed(3),
    })
    res.end(JSON.stringify({ error: String((err && err.message) || err) }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(
    `[gateway:${CLIENT}] listening on http://${HOST}:${PORT} -> ${UPSTREAM} (impersonate=${IMPERSONATE})`
  )
})
