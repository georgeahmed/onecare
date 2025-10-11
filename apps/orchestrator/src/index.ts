import * as http from 'http';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus } from './application/error';
import { callWithGuard, CircuitBreaker } from './adapters/common/guardrails';
import { validatePortalSubmission } from './application/validator';
import { createBusFromEnv } from '@onecare/bus';
import { createEnvelope, PortalSubmission, Topics, TriageInput } from '@onecare/events';
import { logger, setCorrelationId } from '@onecare/observability';
import { deriveIdempotencyKey, reserveIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';

const port = Number(process.env.PORT || process.env.PORT_ORCHESTRATOR || 3001);

const bus = createBusFromEnv();
const safetyBreaker = new CircuitBreaker('safety_gate');
const idemStore = new InMemoryIdempotencyStore();

function cidFromHeaders(headers: http.IncomingHttpHeaders): string {
  const h = headers['x-correlation-id'] || headers['X-Correlation-ID'];
  if (Array.isArray(h)) return h[0];
  if (typeof h === 'string') return h;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }
  const corr = cidFromHeaders(req.headers);
  setCorrelationId(corr);
  if (req.url === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && req.url === '/safety-check') {
    const bufs: Buffer[] = [];
    const maxBytes = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
    let received = 0;
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      received += b.length;
      if (received > maxBytes) {
        const env = errorEnvelope('payload_too_large', `Payload exceeds limit (${maxBytes} bytes)`, undefined, corr);
        res.statusCode = mapErrorToStatus(env.error.code);
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-correlation-id', corr);
        res.end(JSON.stringify(env));
        req.destroy();
        return;
      }
      bufs.push(b);
    });
    req.on('end', async () => {
      try {
        // Content-Type allowlist
        const ctype = (req.headers['content-type'] || '').toString().toLowerCase();
        if (!ctype.includes('application/json')) {
          const env = errorEnvelope('unsupported_media_type', 'Only application/json is supported', undefined, corr);
          res.statusCode = mapErrorToStatus(env.error.code);
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-correlation-id', corr);
          res.end(JSON.stringify(env));
          return;
        }

        // Size limit
        const rawBuf = Buffer.concat(bufs);
        if (rawBuf.length > maxBytes) {
          const env = errorEnvelope('payload_too_large', `Payload exceeds limit (${maxBytes} bytes)`, undefined, corr);
          res.statusCode = mapErrorToStatus(env.error.code);
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-correlation-id', corr);
          res.end(JSON.stringify(env));
          return;
        }

        const raw = rawBuf.toString('utf8');
        let submission: PortalSubmission;
        try {
          submission = JSON.parse(raw) as PortalSubmission;
        } catch {
          const env = errorEnvelope('invalid_input', 'Invalid JSON body', undefined, corr);
          res.statusCode = mapErrorToStatus(env.error.code);
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-correlation-id', corr);
          res.end(JSON.stringify(env));
          return;
        }

        // Schema validation
        const v = validatePortalSubmission(submission);
        if (v.ok !== true) {
          const env = errorEnvelope('invalid_input', 'Invalid request body', { errors: v.errors.slice(0, 5) }, corr);
          res.statusCode = mapErrorToStatus(env.error.code);
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-correlation-id', corr);
          res.end(JSON.stringify(env));
          return;
        }

        // Idempotency guard (10 min TTL default)
        const explicitKeyHeader = req.headers['x-idempotency-key'];
        const explicitKey = Array.isArray(explicitKeyHeader) ? explicitKeyHeader[0] : explicitKeyHeader;
        const idemKey = deriveIdempotencyKey(submission, submission.patient?.id, explicitKey);
        const idemResult = await reserveIdempotency(idemStore, idemKey, { ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SEC || 600) });
        if (idemResult === 'exists') {
          const env = errorEnvelope('conflict', 'Duplicate request', { idempotencyKey: idemKey }, corr);
          res.statusCode = mapErrorToStatus(env.error.code);
          res.setHeader('content-type', 'application/json');
          res.setHeader('x-correlation-id', corr);
          res.end(JSON.stringify(env));
          return;
        }
        const decision = await callWithGuard(
          'safety_gate',
          () => analyzePortalSubmission(submission, undefined, corr),
          { timeoutMs: 800, maxRetries: 1, baseDelayMs: 10 },
          safetyBreaker
        );
        if (decision.outcome === 'SAFE_TO_CONTINUE') {
          const tri: TriageInput = { patientId: submission.patient.id, narrative: submission.narrative };
          const env = createEnvelope(Topics.triage.input, tri, corr);
          await bus.publish(env.topic, env);
          logger.info('published triage.input', { topic: env.topic, correlationId: corr });
        } else {
          logger.info('safety diverted submission', { correlationId: corr });
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-correlation-id', corr);
        res.end(JSON.stringify(decision));
      } catch (err: any) {
        const code: ErrorCode = err?.message && String(err.message).startsWith('circuit_open')
          ? 'upstream_unavailable' : 'internal_error';
        const env = errorEnvelope(code, code === 'upstream_unavailable' ? 'Safety gate unavailable' : 'Unexpected error', undefined, corr);
        res.statusCode = mapErrorToStatus(env.error.code);
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-correlation-id', corr);
        res.end(JSON.stringify(env));
      }
    });
    return;
  }
  res.statusCode = 200;
  res.end('orchestrator skeleton');
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`orchestrator listening on :${port}`);
});
