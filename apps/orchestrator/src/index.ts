import * as http from 'http';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus } from './application/error';
import { callWithGuard, CircuitBreaker } from './adapters/common/guardrails';
import { validatePortalSubmission } from './application/validator';
import { getBus, markNatsBusConnected } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { createEnvelope, PortalSubmission, Topics, TriageInput } from '@onecare/events';
import { initTracing, logger, setCorrelationId } from '@onecare/observability';
import { deriveIdempotencyKey, reserveIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';

const port = Number(process.env.PORT || process.env.PORT_ORCHESTRATOR || 3001);
const wantsNats = Boolean(process.env.NATS_URL && process.env.NATS_URL.trim().length > 0);

void initTracing('orchestrator').catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn('failed to initialize tracing', { message });
});

let bus: MessageBus = getBus();
markNatsBusConnected(bus, !wantsNats);
const safetyBreaker = new CircuitBreaker('safety_gate');
const idemStore = new InMemoryIdempotencyStore();
let busReady = !wantsNats;
let natsConn: NatsConnection | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;

function parseServers(raw: string | undefined): string[] {
  if (!raw) return ['nats://localhost:4222'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildConnectionOptions(): ConnectionOptions {
  const servers = parseServers(process.env.NATS_URL);
  const options: ConnectionOptions = { servers };
  const user = process.env.NATS_USER;
  const pass = process.env.NATS_PASS;
  const token = process.env.NATS_TOKEN;
  if (user) options.user = user;
  if (pass) options.pass = pass;
  if (token) options.token = token;
  const timeoutMs = Number(process.env.NATS_CONNECT_TIMEOUT_MS ?? '');
  if (!Number.isNaN(timeoutMs) && timeoutMs > 0) options.timeout = timeoutMs;
  const maxReconnect = Number(process.env.NATS_MAX_RECONNECT_ATTEMPTS ?? '');
  if (!Number.isNaN(maxReconnect) && maxReconnect >= 0) options.maxReconnectAttempts = maxReconnect;
  const reconnectWait = Number(process.env.NATS_RECONNECT_TIME_WAIT_MS ?? '');
  if (!Number.isNaN(reconnectWait) && reconnectWait > 0) options.reconnectTimeWait = reconnectWait;
  return options;
}

function scheduleReconnect(delayMs?: number) {
  if (reconnectTimer) return;
  const fallbackDelay = Number(process.env.NATS_RECONNECT_DELAY_MS ?? '1500');
  const delay = typeof delayMs === 'number' && delayMs > 0 ? delayMs : (!Number.isNaN(fallbackDelay) && fallbackDelay > 0 ? fallbackDelay : 1500);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void establishBusConnection();
  }, delay);
}

function monitorNats(conn: NatsConnection) {
  (async () => {
    for await (const status of conn.status()) {
      const event = status.type;
      if (event === 'reconnect') {
        busReady = true;
        logger.info('NATS connection restored', { event });
      } else if (
        event === 'disconnect' ||
        event === 'reconnecting' ||
        event === 'staleConnection' ||
        event === 'pingTimer' ||
        event === 'ldm' ||
        event === 'error'
      ) {
        busReady = false;
        logger.warn('NATS connection disrupted', { event });
        if (event === 'disconnect' || event === 'error') {
          scheduleReconnect();
        }
      } else if (event === 'update') {
        logger.info('NATS server list updated', { data: status.data });
      }
    }
    busReady = false;
    logger.warn('NATS status iterator completed unexpectedly');
    scheduleReconnect();
  })().catch((err: unknown) => {
    logger.error('NATS status monitoring failed', { err: err instanceof Error ? err.message : err });
    busReady = false;
    scheduleReconnect();
  });
}

async function establishBusConnection(): Promise<void> {
  if (!wantsNats) {
    busReady = true;
    markNatsBusConnected(bus, true);
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    const options = buildConnectionOptions();
    logger.info('Connecting to NATS', { servers: options.servers });
    const conn = await connect(options);
    natsConn = conn;
    bus = getBus({ connection: conn });
    markNatsBusConnected(bus, true);
    busReady = true;
    monitorNats(conn);
    logger.info('Connected to NATS', { servers: options.servers });
  } catch (err: unknown) {
    busReady = false;
    markNatsBusConnected(bus, false);
    logger.error('Failed to connect to NATS', { err: err instanceof Error ? err.message : err });
    scheduleReconnect();
  }
}

void establishBusConnection();

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
  if (req.url === '/ready') {
    const body = {
      status: busReady ? 'ready' : 'not_ready',
      bus: busReady ? 'connected' : 'disconnected',
    };
    res.statusCode = busReady ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
    return;
  }
  if (req.method === 'POST' && req.url === '/safety-check') {
    if (!busReady) {
      const env = errorEnvelope('upstream_unavailable', 'Event bus unavailable', undefined, corr);
      res.statusCode = mapErrorToStatus(env.error.code);
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-correlation-id', corr);
      res.end(JSON.stringify(env));
      return;
    }
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

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`orchestrator listening on :${port}`);
  });
}

export function setBusReadyForTest(ready: boolean): void {
  busReady = ready;
}

export function getBusReadyForTest(): boolean {
  return busReady;
}

export { server };
