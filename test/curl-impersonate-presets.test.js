const test = require('node:test')
const assert = require('node:assert/strict')
const { fetch, listImpersonatePresets } = require('../index.js')

test('listImpersonatePresets returns all 19 curl-impersonate presets', () => {
  const presets = listImpersonatePresets()
  assert.equal(presets.length, 19)
  const names = presets.map((p) => p.name).sort()
  assert.deepEqual(names, [
    'chrome100',
    'chrome101',
    'chrome104',
    'chrome107',
    'chrome110',
    'chrome116',
    'chrome99',
    'chrome99_android',
    'edge101',
    'edge99',
    'ff100',
    'ff102',
    'ff109',
    'ff117',
    'ff91esr',
    'ff95',
    'ff98',
    'safari15_3',
    'safari15_5',
  ])
})

// Opt-in: `NETWORK_TESTS=1 pnpm test`.
//
// This hits a real TLS-fingerprint echo service (tls.peet.ws) rather than a
// local mock, because JA4/Akamai fingerprints can only be observed on a real
// handshake -- there is no way to assert this offline. That makes it the only
// check that our impersonate presets actually produce the fingerprint they
// claim, so it is gated rather than deleted.
//
// It does not run by default because a third party's uptime and rate limits
// then decide whether CI is green: it went red across every platform on an
// unrelated change ("error sending request for uri (https://tls.peet.ws/api/all)")
// while 36/37 other tests passed, purely because several build matrices were
// hitting the service at once. A red run that says nothing about the diff
// trains people to ignore red runs.
//
// Run it before trusting any fingerprint-affecting change (impersonate
// presets, TLS options, a wreq/BoringSSL bump). The full 19-preset sweep was
// run manually during development; this keeps one representative preset.
const NETWORK_TESTS = process.env.NETWORK_TESTS === '1'

test(
  'a curl-impersonate preset resolves through fetch() and matches its native profile JA4',
  {
    skip: NETWORK_TESTS ? false : 'hits tls.peet.ws; set NETWORK_TESTS=1 to run',
  },
  async () => {
    const preset = listImpersonatePresets().find((p) => p.name === 'chrome116')
    assert.ok(preset && preset.exact)

    const viaCurlName = await fetch('https://tls.peet.ws/api/all', { impersonate: preset.name })
    const viaNativeProfile = await fetch('https://tls.peet.ws/api/all', {
      impersonate: preset.profile,
    })
    assert.equal(viaCurlName.status, 200)
    assert.equal(viaNativeProfile.status, 200)

    const a = await viaCurlName.json()
    const b = await viaNativeProfile.json()

    // JA4 is "<version/sni/cipher-count/ext-count/alpn>_<cipher-hash>_<ext-hash>".
    // Whether a given connection is a fresh handshake or resumes a cached TLS
    // session flips the extension-count digits in the first segment (observed:
    // t13d1516h2 vs t13d1517h2) independently of the emulation profile, so
    // comparing the full string is flaky. The cipher-suite and extension-set
    // hashes (segments 2 and 3) are what actually identify the fingerprint and
    // stay stable, so compare those instead of the full JA4 string.
    const fingerprintOf = (ja4) => ja4.split('_').slice(1).join('_')
    assert.equal(fingerprintOf(a.tls.ja4), fingerprintOf(b.tls.ja4))
  }
)
