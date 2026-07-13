const { fetch } = require('../index.js')

const url = process.argv[2]
const impersonate = process.env.IMPERSONATE || 'chrome_147'

async function run() {
  const start = performance.now()
  try {
    const res = await fetch(url, { impersonate })
    await res.arrayBuffer()
    const elapsed = performance.now() - start
    console.log(JSON.stringify({ ok: true, status: res.status, elapsed }))
  } catch (err) {
    const elapsed = performance.now() - start
    console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err), elapsed }))
  }
}
run()
