import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.SAFETY_CHECK_BASE_URL || 'http://localhost:3001';
const ACTOR_TYPE = __ENV.SAFETY_CHECK_ACTOR_TYPE || 'patient';
const ACTOR_ID = __ENV.SAFETY_CHECK_ACTOR_ID || 'synthetic-patient';
const AUTH_SCOPE = __ENV.SAFETY_CHECK_AUTH_SCOPE || 'submit triage:submit';
const PRACTICE_ID = __ENV.SAFETY_CHECK_PRACTICE_ID || 'demo';
const CHANNEL = __ENV.SAFETY_CHECK_CHANNEL || 'web';
const ITERATIONS = Number.parseInt(__ENV.SAFETY_CHECK_ITERATIONS || '5', 10);
const VUS = Number.parseInt(__ENV.SAFETY_CHECK_VUS || '2', 10);
const MAX_DURATION = __ENV.SAFETY_CHECK_MAX_DURATION || '1m';
const TIMEOUT = __ENV.SAFETY_CHECK_TIMEOUT || '3s';
const SHARED_SECRET = __ENV.SAFETY_CHECK_SHARED_SECRET || __ENV.SECURITY_SHARED_SECRET || '';
const FALLBACK_AUTH_HEADER = __ENV.SAFETY_CHECK_AUTH_HEADER || 'Bearer dev-token';

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

const toBase64Url = (bytes) =>
  bytes
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const sha256Hex = (value) => crypto.sha256(value, 'hex');

const deriveAttachmentDigest = (attachment) => {
  const contentType = typeof attachment?.contentType === 'string' ? attachment.contentType : '';
  const url = typeof attachment?.url === 'string' ? attachment.url : '';
  return sha256Hex(`${contentType}\u0000${url}`);
};

const deriveIdempotencyKey = (payload) => {
  const base = {
    practiceId: payload.practiceId,
    patientId: payload.patient?.id,
    narrativeLength: payload.narrative?.length ?? 0,
    channel: payload.channel,
    attachmentsCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
  };
  const segments = [JSON.stringify(base)];

  if (payload.narrative) {
    segments.push(sha256Hex(payload.narrative));
  }

  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    const attachmentDigests = payload.attachments.map(deriveAttachmentDigest).sort();
    segments.push(...attachmentDigests);
  }

  const actorId = typeof payload.patient?.id === 'string' ? payload.patient.id.trim() : '';
  if (actorId) {
    segments.push(`:${actorId}`);
  }

  return sha256Hex(segments.join(''));
};

const buildAuthHeaders = (fingerprint, idempotencyKey) => {
  if (SHARED_SECRET) {
    const token = toBase64Url(crypto.hmac('sha256', SHARED_SECRET, fingerprint, 'base64'));
    return {
      authorization: `Bearer ${token}`,
      'x-idempotency-key': idempotencyKey,
    };
  }
  return {
    authorization: FALLBACK_AUTH_HEADER,
    'x-idempotency-key': idempotencyKey,
  };
};

export default function runSafetyCheck() {
  const requestId = uuidv4();
  const correlationId = uuidv4();
  const payload = {
    practiceId: PRACTICE_ID,
    channel: CHANNEL,
    patient: { id: ACTOR_ID },
    narrative: 'Synthetic load smoke (QA-01.14)',
  };
  const baseIdempotencyKey = deriveIdempotencyKey(payload);
  const idempotencyKey = `${baseIdempotencyKey}:${requestId}`;
  const fingerprint = `${requestId}:${idempotencyKey}`;
  const authHeaders = buildAuthHeaders(fingerprint, idempotencyKey);

  const headers = {
    'content-type': 'application/json',
    'x-actor-type': ACTOR_TYPE,
    'x-actor-id': ACTOR_ID,
    'x-request-id': requestId,
    'x-auth-scope': AUTH_SCOPE,
    'x-correlation-id': correlationId,
    ...authHeaders,
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
