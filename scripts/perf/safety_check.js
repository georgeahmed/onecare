import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import crypto from 'k6/crypto';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_SHARED_SECRET = 'test-shared-secret';
const DEFAULT_PRACTICE_ID = 'demo';
const DEFAULT_PATIENT_ID = 'patient-load';
const DEFAULT_MIN_RATE = 5;
const DEFAULT_P50_MS = 400;
const DEFAULT_P95_MS = 900;
const DEFAULT_SLEEP_SECONDS = 0.2;

const vus = Number(__ENV.SAFETY_CHECK_VUS ?? 10);
const duration = __ENV.SAFETY_CHECK_DURATION ?? '2m';
const minRate = Number(__ENV.SAFETY_CHECK_MIN_RATE ?? DEFAULT_MIN_RATE);
const p50 = Number(__ENV.SAFETY_CHECK_P50_MS ?? DEFAULT_P50_MS);
const p95 = Number(__ENV.SAFETY_CHECK_P95_MS ?? DEFAULT_P95_MS);
const sleepSeconds = Number(__ENV.SAFETY_CHECK_SLEEP ?? DEFAULT_SLEEP_SECONDS);

export const options = {
  vus,
  duration,
  thresholds: {
    http_req_duration: [`p(50)<${p50}`, `p(95)<${p95}`],
    http_reqs: [`rate>${minRate}`],
    checks: ['rate>0.99'],
  },
};

const durationTrend = new Trend('safety_check_duration_ms', true);

const baseUrl = __ENV.SAFETY_CHECK_BASE_URL ?? DEFAULT_BASE_URL;
const sharedSecret = __ENV.SAFETY_CHECK_SECRET ?? DEFAULT_SHARED_SECRET;
const practiceId = __ENV.SAFETY_CHECK_PRACTICE_ID ?? DEFAULT_PRACTICE_ID;
const patientId = __ENV.SAFETY_CHECK_PATIENT_ID ?? DEFAULT_PATIENT_ID;

const baseSubmission = {
  practiceId,
  patient: { id: patientId },
  narrative: 'Baseline safety-check load probe',
  channel: 'web',
};

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deriveIdempotencyKey(submission, actorId, explicitKey) {
  if (explicitKey) return explicitKey;
  const hash = crypto.createHash('sha256');
  const base = {
    practiceId: submission.practiceId,
    patientId: submission.patient?.id,
    narrativeLength: submission.narrative?.length ?? 0,
    channel: submission.channel,
    attachmentsCount: Array.isArray(submission.attachments) ? submission.attachments.length : 0,
  };
  hash.update(JSON.stringify(base));

  if (submission.narrative) {
    const narrativeDigest = sha256Hex(submission.narrative);
    hash.update(narrativeDigest);
  }

  if (Array.isArray(submission.attachments) && submission.attachments.length > 0) {
    const attachmentDigests = submission.attachments
      .map((attachment) => {
        const attHash = crypto.createHash('sha256');
        attHash.update(String(attachment?.contentType ?? ''));
        attHash.update('\u0000');
        attHash.update(String(attachment?.url ?? ''));
        return attHash.digest('hex');
      })
      .sort();

    for (const digest of attachmentDigests) {
      hash.update(digest);
    }
  }

  if (actorId) {
    hash.update(`:${actorId}`);
  }

  return hash.digest('hex');
}

function randomSuffix() {
  return Math.random().toString(16).slice(2, 10);
}

function createId(prefix) {
  const epoch = Date.now();
  return `${prefix}-${__VU}-${__ITER}-${epoch}-${randomSuffix()}`;
}

function hmacBase64Url(secret, data) {
  const raw = crypto.hmac('sha256', secret, data, 'base64');
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export default function safetyCheckLoad() {
  const submission = Object.assign({}, baseSubmission);
  const requestId = createId('req');
  const correlationId = createId('corr');
  const explicitIdempotencyKey = sha256Hex(`${requestId}-${randomSuffix()}`);
  const idempotencyKey = deriveIdempotencyKey(submission, patientId, explicitIdempotencyKey);
  const fingerprint = `${requestId}:${idempotencyKey}`;
  const signature = hmacBase64Url(sharedSecret, fingerprint);

  const headers = {
    authorization: `Bearer ${signature}`,
    'content-type': 'application/json',
    'x-actor-id': patientId,
    'x-actor-type': 'patient',
    'x-auth-scope': 'submit',
    'x-request-id': requestId,
    'x-correlation-id': correlationId,
    'x-idempotency-key': idempotencyKey,
  };

  const res = http.post(`${baseUrl}/safety-check`, JSON.stringify(submission), {
    headers,
    timeout: __ENV.SAFETY_CHECK_TIMEOUT ?? '5s',
  });

  durationTrend.add(res.timings.duration);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'outcome safe-to-continue': (r) => {
      try {
        const body = r.json();
        return body?.outcome === 'SAFE_TO_CONTINUE';
      } catch (err) {
        return false;
      }
    },
  });

  if (sleepSeconds > 0) {
    sleep(sleepSeconds);
  }
}
