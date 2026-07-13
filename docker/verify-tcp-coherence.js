// Confirms the TCP/IP-coherence claim this Dockerfile exists for: that
// running this container makes the passive TCP/IP fingerprint (TTL, window
// size, TCP option order -> OS guess) say "Linux", matching a `platform:
// 'linux'` fetch() call's declared headers -- instead of the mismatch a bare
// macOS/Windows host would produce (see ../README.md "Known limitations").
//
// Hits a real third-party fingerprinting service (not a mock) because the
// TCP/IP signal can only be observed from the server side of an actual
// handshake -- there's nothing to assert against locally.
const { fetch } = require('../index.js')

const ENDPOINT = 'https://networktest.proxywing.com:8443/api/all'

async function main() {
  const res = await fetch(ENDPOINT, { impersonate: 'chrome_147', platform: 'linux' })
  if (!res.ok) {
    console.error(`FAIL: ${ENDPOINT} returned ${res.status}`)
    process.exit(1)
  }

  const data = await res.json()
  const osGuess = data.tcpip && data.tcpip.os_guess
  const ttl = data.tcpip && data.tcpip.init_ttl
  const optionOrder = data.tcpip && data.tcpip.tcp_options_order

  console.log('ja4:               ', data.ja4)
  console.log('user_agent:        ', data.user_agent)
  console.log('tcpip.os_guess:    ', osGuess)
  console.log('tcpip.init_ttl:    ', ttl)
  console.log('tcpip.tcp_options_order:', JSON.stringify(optionOrder))

  const looksLinux =
    typeof osGuess === 'string' && /linux/i.test(osGuess) && !/windows|mac ?os|ios/i.test(osGuess)

  if (looksLinux) {
    console.log(
      '\nPASS: tcpip.os_guess reports Linux -- TCP/IP layer is coherent with platform: "linux".'
    )
    process.exit(0)
  }

  console.error(`\nFAIL: tcpip.os_guess is "${osGuess}", expected something Linux-only.`)
  console.error('Verified cause on Docker Desktop for Mac: its network virtualization NATs/proxies')
  console.error('container egress through the macOS host stack rather than exposing the Linux VM')
  console.error(
    'kernel directly to the internet, so the TCP/IP fingerprint stays macOS/Windows even'
  )
  console.error(
    'though `uname -a` inside the container correctly reports Linux. This container image'
  )
  console.error(
    'only buys real TCP/IP coherence on an actual Linux Docker host (bare metal or a cloud'
  )
  console.error('VM) -- re-run this script there before relying on it. See ../README.md.')
  process.exit(1)
}

main().catch((err) => {
  console.error('FAIL: request errored:', err)
  process.exit(1)
})
