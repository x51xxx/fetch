const http = require('node:http')

const PORT = Number(process.env.PORT || 9301)
const HOST = process.env.HOST || '127.0.0.1'

let requestCount = 0
let socketCount = 0
const liveSockets = new Set()
const bodyCache = new Map()

function bodyFor(sizeBytes) {
  let buf = bodyCache.get(sizeBytes)
  if (!buf) {
    buf = Buffer.alloc(sizeBytes, 'x')
    bodyCache.set(sizeBytes, buf)
  }
  return buf
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://internal')

  if (url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ requests: requestCount, sockets: socketCount, liveSockets: liveSockets.size }))
    return
  }
  if (url.pathname === '/reset') {
    requestCount = 0
    socketCount = 0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  requestCount++
  const delayMs = Number(url.searchParams.get('delay') || 0)
  const sizeBytes = Number(url.searchParams.get('size') || 512)
  const body = bodyFor(sizeBytes)

  const send = () => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    res.end(body)
  }
  if (delayMs > 0) setTimeout(send, delayMs)
  else send()
})

server.on('connection', (socket) => {
  socketCount++
  liveSockets.add(socket)
  socket.on('close', () => liveSockets.delete(socket))
})

server.keepAliveTimeout = 60_000
server.listen(PORT, HOST, () => {
  console.log(`[upstream] listening on http://${HOST}:${PORT}`)
})
