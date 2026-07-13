import http from 'k6/http'
import { check } from 'k6'
import { Trend, Counter } from 'k6/metrics'

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:9401'
const DELAY = __ENV.DELAY || '0'
const SIZE = __ENV.SIZE || '1024'
const EXECUTOR = __ENV.EXECUTOR || 'constant-vus' // 'constant-vus' | 'constant-arrival-rate'
const VUS = Number(__ENV.VUS || 10)
const DURATION = __ENV.DURATION || '20s'
const RATE = Number(__ENV.RATE || 50) // requests/sec for constant-arrival-rate
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(VUS, 20))
const MAX_VUS = Number(__ENV.MAX_VUS || PRE_ALLOCATED_VUS * 3)

const scenario = EXECUTOR === 'constant-arrival-rate'
  ? {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    }
  : {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    }

export const options = {
  scenarios: { main: scenario },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
}

const upstreamMs = new Trend('upstream_ms', true)
const clientErrors = new Counter('client_errors')

export default function () {
  const res = http.get(`${TARGET_URL}/bench?delay=${DELAY}&size=${SIZE}`)
  const ok = check(res, { 'status 200': (r) => r.status === 200 })
  if (!ok) clientErrors.add(1)
  const hdr = res.headers['X-Upstream-Ms']
  if (hdr) upstreamMs.add(Number(hdr))
}
