import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.SAFETY_CHECK_BASE_URL || 'http://localhost:3001';
const AUTH_HEADER = __ENV.SAFETY_CHECK_AUTH_HEADER || 'Bearer dev-token';
const ACTOR_TYPE = __ENV.SAFETY_CHECK_ACTOR_TYPE || 'patient';
const ACTOR_ID = __ENV.SAFETY_CHECK_ACTOR_ID || 'synthetic-patient';
const AUTH_SCOPE = __ENV.SAFETY_CHECK_AUTH_SCOPE || 'submit triage:submit';
const PRACTICE_ID = __ENV.SAFETY_CHECK_PRACTICE_ID || 'demo';
const CHANNEL = __ENV.SAFETY_CHECK_CHANNEL || 'web';
const ITERATIONS = Number.parseInt(__ENV.SAFETY_CHECK_ITERATIONS || '5', 10);
const VUS = Number.parseInt(__ENV.SAFETY_CHECK_VUS || '2', 10);
const MAX_DURATION = __ENV.SAFETY_CHECK_MAX_DURATION || '1m';
const TIMEOUT = __ENV.SAFETY_CHECK_TIMEOUT || '3s';

export const options = {
  scenarios: {
    smoke: {
      executor: 'per-vu-iterations',
      vus: Number.isFinite(VUS) && VUS > 0 ? VUS : 2,
      iterations: Number.isFinite(ITERATIONS) && ITERATIONS > 0 ? ITERATIONS : 5,
      maxDuration: MAX_DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(50)<750', 'p(95)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

const durationTrend = new Trend('safety_check_duration', true);

export default function runSafetyCheck() {
  const requestId = uuidv4();
  const correlationId = uuidv4();
  const payload = {
    practiceId: PRACTICE_ID,
    channel: CHANNEL,
    patient: { id: ACTOR_ID },
    narrative: 'Synthetic load smoke (QA-01.14)',
  };

  const headers = {
    'content-type': 'application/json',
    authorization: AUTH_HEADER,
    'x-actor-type': ACTOR_TYPE,
    'x-actor-id': ACTOR_ID,
    'x-request-id': requestId,
    'x-auth-scope': AUTH_SCOPE,
    'x-correlation-id': correlationId,
  };

  const response = http.post(`${BASE_URL}/safety-check`, JSON.stringify(payload), {
    headers,
    timeout: TIMEOUT,
  });

  durationTrend.add(response.timings.duration);

  check(response, {
    'status is 200': (res) => res.status === 200,
    'correlation echoed': (res) => res.headers['x-correlation-id'] === correlationId,
  });
}

export function handleSummary(data) {
  const httpMetrics = data.metrics['http_req_duration'] || {};
  const percentiles = httpMetrics.percentiles || {};
  const p50 = percentiles['50.00'] ?? percentiles['50'] ?? 0;
  const p95 = percentiles['95.00'] ?? percentiles['95'] ?? 0;
  const failRate = (data.metrics['http_req_failed']?.rate ?? 0) * 100;

  const lines = [
    '[k6] safety-check smoke summary',
    ` baseUrl         : ${BASE_URL}`,
    ` requests        : ${data.metrics.iterations?.count ?? 0}`,
    ` http_req_duration p50 : ${p50.toFixed(2)} ms`,
    ` http_req_duration p95 : ${p95.toFixed(2)} ms`,
    ` http_req_failed     : ${failRate.toFixed(3)} %`,
  ];

  return {
    stdout: `${lines.join('\n')}\n`,
  };
}

