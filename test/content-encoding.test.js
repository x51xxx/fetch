// `Content-Encoding: deflate` is ambiguous in the wild: RFC 2616 meant a
// zlib-wrapped stream (RFC 1950), but plenty of origins -- PHP/Apache with
// `zlib.output_compression` above all -- send a bare DEFLATE stream (RFC 1951)
// under the same token. Browsers accept both, so a client that impersonates one
// has to as well. These tests pin both flavours, on both the buffered and the
// streaming path, plus the header parity that makes the decode invisible to JS.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')
const { deflateSync, deflateRawSync, gzipSync, zstdCompressSync } = require('node:zlib')

const { fetch } = require('../index.js')

const KiB = 1024
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

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

// Compressible but not trivially so, and larger than one decoded chunk (64 KiB)
// so the decoder has to emit several.
function payload(bytes = 768 * KiB) {
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 29 + (i >>> 8)) & 0xff
  return buf
}

function serveEncoded(encoding, encoded) {
  return (req, res) => {
    res.writeHead(200, {
      'content-encoding': encoding,
      'content-length': String(encoded.length),
      'content-type': 'application/xml',
    })
    res.end(encoded)
  }
}

for (const [flavour, compress] of [
  ['zlib-wrapped (RFC 1950)', deflateSync],
  ['raw (RFC 1951)', deflateRawSync],
]) {
  test(`buffered fetch decodes ${flavour} deflate`, async () => {
    const body = payload()
    const encoded = compress(body)
    await withServer(serveEncoded('deflate', encoded), async (base) => {
      const res = await fetch(base)
      const got = Buffer.from(await res.arrayBuffer())
      assert.equal(got.length, body.length)
      assert.equal(sha(got), sha(body))
    })
  })

  test(`streaming fetch decodes ${flavour} deflate`, async () => {
    const body = payload()
    const encoded = compress(body)
    await withServer(serveEncoded('deflate', encoded), async (base) => {
      const res = await fetch(base, { stream: true })
      const chunks = []
      let offset = 0
      for await (const chunk of res.body) {
        const bytes = Buffer.from(chunk)
        assert.deepEqual(
          bytes,
          body.subarray(offset, offset + bytes.length),
          'chunks must carry decoded bytes, not compressed wire bytes'
        )
        offset += bytes.length
        chunks.push(bytes)
      }
      assert.equal(offset, body.length)
      assert.equal(sha(Buffer.concat(chunks)), sha(body))
    })
  })

  // The point of doing this in Rust rather than in the caller: JS must not be
  // able to tell which decoder ran. wreq strips both headers when it decodes
  // gzip/br/zstd, so the deflate path has to strip them too.
  test(`${flavour} deflate response hides content-encoding/content-length`, async () => {
    const encoded = compress(payload(4 * KiB))
    await withServer(serveEncoded('deflate', encoded), async (base) => {
      const res = await fetch(base)
      assert.equal(res.headers.get('content-encoding'), null)
      assert.equal(res.headers.get('content-length'), null)
      assert.equal(res.headers.get('content-type'), 'application/xml')
      await res.arrayBuffer()
    })
  })
}

// Baseline for the assertion above: the encodings wreq still decodes behave the
// same way, so the two paths cannot drift apart unnoticed.
test('gzip response hides content-encoding/content-length', async () => {
  const encoded = gzipSync(payload(4 * KiB))
  await withServer(serveEncoded('gzip', encoded), async (base) => {
    const res = await fetch(base)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.equal(res.headers.get('content-length'), null)
    await res.arrayBuffer()
  })
})

// Sniffing needs two bytes. A body that never provides them is a legal empty
// response, not a truncated deflate stream, and must not become a decode error.
test('an empty body carrying content-encoding: deflate decodes to nothing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-encoding': 'deflate', 'content-length': '0' })
      res.end()
    },
    async (base) => {
      const buffered = await fetch(base)
      assert.equal(await buffered.text(), '')

      const streamed = await fetch(base, { stream: true })
      const chunks = []
      for await (const chunk of streamed.body) chunks.push(Buffer.from(chunk))
      assert.equal(Buffer.concat(chunks).length, 0)
    }
  )
})

test('204 with content-encoding: deflate decodes to nothing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(204, { 'content-encoding': 'deflate' })
      res.end()
    },
    async (base) => {
      const res = await fetch(base)
      assert.equal(res.status, 204)
      assert.equal(await res.text(), '')
    }
  )
})

test('a body that is not deflate at all fails as DECODE', async () => {
  const junk = Buffer.from('this is definitely not a deflate stream, raw or wrapped')
  await withServer(serveEncoded('deflate', junk), async (base) => {
    await assert.rejects(fetch(base), (err) => {
      assert.equal(err.code, 'DECODE')
      assert.match(err.message, /failed to read response body/)
      return true
    })
  })
})

// A truncated stream is a decode failure too -- and it must surface, not be
// silently reported as a short-but-successful body.
test('a truncated deflate stream fails rather than returning a partial body', async () => {
  const encoded = deflateRawSync(payload())
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-encoding': 'deflate' })
      res.end(encoded.subarray(0, Math.floor(encoded.length / 2)))
    },
    async (base) => {
      await assert.rejects(fetch(base), /failed to read response body/)
    }
  )
})

// maxResponseBytes has to be measured on decoded bytes: deflate reaches ~1000x,
// so a cap applied to the wire bytes would be no cap at all.
test('maxResponseBytes counts decoded deflate bytes', async () => {
  const body = payload(512 * KiB)
  const encoded = deflateRawSync(body)
  assert.ok(encoded.length < 256 * KiB, 'test payload must actually compress')
  await withServer(serveEncoded('deflate', encoded), async (base) => {
    await assert.rejects(
      fetch(base, { maxResponseBytes: 256 * KiB }),
      (err) => err.code === 'RESPONSE_TOO_LARGE'
    )
    const res = await fetch(base, { maxResponseBytes: body.length })
    assert.equal((await res.arrayBuffer()).byteLength, body.length)
  })
})

// Decoding deflate ourselves means turning wreq's own deflate decoder off, and
// that must not reach the wire: the emulation profile owns `accept-encoding`,
// and dropping `deflate` from it would be a visible deviation from the browser
// being impersonated.
test('accept-encoding is the impersonated profile’s own header', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(req.headers['accept-encoding'] ?? '')
    },
    async (base) => {
      const sent = async (options) => (await fetch(base, options)).text()

      // Verbatim browser values, spacing included. A synthesised header built
      // from whichever decoders happen to be compiled in ("gzip,deflate,br")
      // is a fingerprint tell no `impersonate` value can hide.
      assert.equal(await sent(), 'gzip, deflate, br, zstd')
      assert.equal(await sent({ impersonate: 'chrome_147' }), 'gzip, deflate, br, zstd')
      assert.equal(await sent({ impersonate: 'firefox_133' }), 'gzip, deflate, br, zstd')
      assert.equal(await sent({ impersonate: 'safari_18' }), 'gzip, deflate, br')
      // Pre-zstd browsers and non-browsers must stay narrow rather than
      // inheriting a superset from us.
      assert.equal(await sent({ impersonate: 'chrome116' }), 'gzip, deflate, br')
      assert.equal(await sent({ impersonate: 'okhttp_5' }), 'gzip')
    }
  )
})

// Advertised above, so it has to work: nothing else in the suite covers zstd.
test('zstd is decoded', async () => {
  const body = payload(64 * KiB)
  const encoded = zstdCompressSync(body)
  await withServer(serveEncoded('zstd', encoded), async (base) => {
    const res = await fetch(base)
    assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(body))
    assert.equal(res.headers.get('content-encoding'), null)
  })
})

// Only a lone `deflate` token is claimed. A chain is left exactly as it was
// before this decoder existed -- guessing at the order is worse than not
// decoding -- and the untouched headers are how a caller can tell.
test('a multi-token content-encoding is left alone', async () => {
  const encoded = gzipSync(deflateRawSync(payload(4 * KiB)))
  await withServer(serveEncoded('deflate, gzip', encoded), async (base) => {
    const res = await fetch(base).catch((err) => err)
    if (res instanceof Error) {
      assert.match(res.message, /failed to read response body/)
      return
    }
    assert.equal(res.headers.get('content-encoding'), 'deflate, gzip')
    await res.arrayBuffer()
  })
})
