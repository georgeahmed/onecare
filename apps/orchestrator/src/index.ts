import * as http from 'http';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus, redact } from './application/error';
import { callWithGuard, CircuitBreaker } from './adapters/common/guardrails';
import { validatePortalSubmission } from './application/validator';
import { getBus, markNatsBusConnected } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { createEnvelope, PortalSubmission, Topics, TriageInput, AuditEvent } from '@onecare/events';
import { initTracing, logger, setCorrelationId } from '@onecare/observability';
import { deriveIdempotencyKey, reserveIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';
import type { AuthContext } from '@onecare/security';
import { getSecurityServices } from './adapters/security';
import { loadConfig, type ResolvedConfig } from '@onecare/config';
import { createAuditEvent, getAuditLedger } from './adapters/audit';

const port = Number(process.env.PORT || process.env.PORT_ORCHESTRATOR || 3001);
const wantsNats = Boolean(process.env.NATS_URL && process.env.NATS_URL.trim().length > 0);
const practiceId = process.env.PRACTICE_ID?.trim() || 'demo';
const practiceConfig: ResolvedConfig = loadConfig(practiceId);
const safetyGateSettings = practiceConfig.safety_gate ?? {};
const safetyGateTimeoutMs = safetyGateSettings.timeout_ms ?? 800;
const safetyGateFallbackMode = safetyGateSettings.fallback ?? 'rules';

logger.info('practice config applied', {
  practiceId: practiceConfig.practiceId,
  safetyGate: {
    timeoutMs: safetyGateTimeoutMs,
    fallback: safetyGateFallbackMode,
    redFlagThreshold: safetyGateSettings.red_flag_threshold,
    emergencyConfidence: safetyGateSettings.emergency_confidence,
  },
  fairnessFloors: practiceConfig.fairness_floors,
  holdBackFraction: practiceConfig.hold_back_fraction,
});

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
const CONSENT_RESOURCES = ['QuestionnaireResponse', 'Communication'] as const;
const AUDIT_DENIED_TYPE = 'orchestrator.access.denied';
const AUDIT_SUCCESS_TYPE = 'orchestrator.access.success';

class HttpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

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

type RequestOutcome = ErrorCode | 'ok';

function respondJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  correlationId: string | undefined,
  setOutcome: (value: RequestOutcome) => void,
  outcome: RequestOutcome = 'ok'
): void {
  setOutcome(outcome);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  if (correlationId) res.setHeader('x-correlation-id', correlationId);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function respondError(
  res: http.ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: string | undefined,
  setOutcome: (value: RequestOutcome) => void,
  details?: Record<string, unknown>
): void {
  const envelope = errorEnvelope(code, message, details, correlationId);
  respondJson(res, mapErrorToStatus(code), envelope, correlationId, setOutcome, code);
}

function recordHttpMetrics(route: string, outcome: RequestOutcome, durationMs: number): void {
  logger.info('metric.http.request', {
    route,
    outcome,
    durationMs: Number(durationMs.toFixed(2)),
  });
}

function classifyError(err: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (err instanceof HttpError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  const reason = err instanceof Error ? err.message : String(err);
  if (reason && reason.toLowerCase().includes('timeout')) {
    return { code: 'upstream_timeout', message: 'Upstream timeout' };
  }
  if (reason && reason.startsWith('circuit_open')) {
    return { code: 'upstream_unavailable', message: 'Safety gate unavailable' };
  }
  return { code: 'internal_error', message: 'Unexpected error' };
}

type HttpHandler = (setOutcome: (value: RequestOutcome) => void) => Promise<void>;

function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  correlationId: string,
  handler: HttpHandler
): void {
  const start = process.hrtime.bigint();
  let outcome: RequestOutcome = 'ok';
  const setOutcome = (value: RequestOutcome) => {
    outcome = value;
  };

  const finalize = () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    recordHttpMetrics(route, outcome, durationMs);
  };

  handler(setOutcome)
    .catch((err) => {
      const { code, message, details } = classifyError(err);
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('request failure', {
        route,
        correlationId,
        code,
        reason,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
        headers: redact(req.headers as Record<string, unknown>),
      });
      if (!res.headersSent && !res.writableEnded) {
        respondError(res, code, message, correlationId, setOutcome, details);
      }
    })
    .finally(finalize)
    .catch((err) => {
      // finalization errors should never occur; log defensively
      logger.error('request finalization failure', {
        route,
        correlationId,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const abort = (err: HttpError) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        abort(new HttpError('payload_too_large', `Payload exceeds limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new HttpError('internal_error', 'Failed to read request body', { reason: err.message }));
    });
  });
}

function getHeader(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  const raw = headers[lower] ?? headers[name];
  if (Array.isArray(raw)) return raw[0];
  if (typeof raw === 'string') return raw;
  return undefined;
}

function normalizeActorType(raw: string | undefined): AuthContext['actor']['type'] | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'patient' || lower === 'practitioner' || lower === 'system') {
    return lower;
  }
  return null;
}

function buildAuthContext(headers: http.IncomingHttpHeaders): AuthContext | null {
  const actorId = getHeader(headers, 'x-actor-id');
  const actorType = normalizeActorType(getHeader(headers, 'x-actor-type'));
  if (!actorId || !actorType) return null;
  const scopeHeader = getHeader(headers, 'x-auth-scope');
  const scope = scopeHeader
    ? scopeHeader
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  return {
    actor: { type: actorType, id: actorId },
    scope,
  };
}

async function emitAuditEvent(
  type: string,
  correlationId: string | undefined,
  actor: AuthContext['actor'] | null | undefined,
  details: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    type,
    timestamp: new Date().toISOString(),
    correlationId,
    actor: actor ? `${actor.type}:${actor.id}` : null,
    details,
  };
  try {
    const env = createEnvelope(Topics.audit.event, event, correlationId);
    await bus.publish(env.topic, env);
  } catch (err) {
    logger.warn('failed to publish audit event', {
      type,
      correlationId,
      err: err instanceof Error ? err.message : err,
    });
  }
}

function recordAudit(type: string, correlationId: string | undefined, payload?: Record<string, unknown>): void {
  const ledgerEvent = createAuditEvent(type, { correlationId, payload });
  void getAuditLedger()
    .write(ledgerEvent)
    .catch((err) => {
      logger.warn('audit ledger write failed', {
        type,
        correlationId,
        err: err instanceof Error ? err.message : err,
      });
    });
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
    const routeLabel = 'POST /safety-check';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!busReady) {
        req.resume();
        respondError(res, 'upstream_unavailable', 'Event bus unavailable', corr, setOutcome);
        return;
      }

      const maxBytes = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
      const rawBuf = await readRequestBody(req, maxBytes);

      const ctype = (req.headers['content-type'] || '').toString().toLowerCase();
      if (!ctype.includes('application/json')) {
        respondError(res, 'unsupported_media_type', 'Only application/json is supported', corr, setOutcome);
        return;
      }

      const raw = rawBuf.toString('utf8');
      let submission: PortalSubmission;
      try {
        submission = JSON.parse(raw) as PortalSubmission;
      } catch {
        throw new HttpError('invalid_input', 'Invalid JSON body');
      }

      const validation = validatePortalSubmission(submission);
      if (validation.ok !== true) {
        respondError(
          res,
          'invalid_input',
          'Invalid request body',
          corr,
          setOutcome,
          { errors: validation.errors.slice(0, 5) }
        );
        return;
      }

      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr;
      const authHeader = getHeader(req.headers, 'authorization');
      const authContext = buildAuthContext(req.headers);
      type DenialReason = 'signature_invalid' | 'actor_missing' | 'not_authorized' | 'consent_denied';
      const deny = async (reason: DenialReason, extraDetails: Record<string, unknown> = {}): Promise<void> => {
        logger.warn('zero-trust gate denied request', {
          reason,
          correlationId: corr,
          requestId,
          actorType: authContext?.actor?.type,
          actorId: authContext?.actor?.id,
        });
        const auditDetails = {
          reason,
          requestId,
          patientId: submission.patient?.id,
          scope: authContext?.scope,
          ...extraDetails,
        } satisfies Record<string, unknown>;
        recordAudit(AUDIT_DENIED_TYPE, corr, auditDetails);
        await emitAuditEvent(AUDIT_DENIED_TYPE, corr, authContext?.actor ?? null, auditDetails);
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
      };

      if (!(await security.verifySignatureAndReplayGuard(authHeader, requestId))) {
        await deny('signature_invalid', { hasAuthHeader: Boolean(authHeader) });
        return;
      }

      if (!authContext) {
        await deny('actor_missing');
        return;
      }

      const { actor, scope } = authContext;
      const patientId = submission.patient.id;

      if (!(await security.authorize(actor, 'submit', patientId, scope))) {
        await deny('not_authorized');
        return;
      }

      if (!(await security.checkConsent(patientId, 'care', Array.from(CONSENT_RESOURCES)))) {
        await deny('consent_denied');
        return;
      }

      const explicitKeyHeader = req.headers['x-idempotency-key'];
      const explicitKey = Array.isArray(explicitKeyHeader) ? explicitKeyHeader[0] : explicitKeyHeader;
      const idemKey = deriveIdempotencyKey(submission, actor.id, explicitKey);
      const idemResult = await reserveIdempotency(idemStore, idemKey, {
        ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SEC || 600),
      });
      if (idemResult === 'exists') {
        respondError(res, 'conflict', 'Duplicate request', corr, setOutcome, { idempotencyKey: idemKey });
        return;
      }

      const decision = await callWithGuard(
        'safety_gate',
        () => analyzePortalSubmission(submission, undefined, corr),
        { timeoutMs: safetyGateTimeoutMs, maxRetries: 1, baseDelayMs: 10 },
        safetyBreaker
      );

      if (decision.outcome === 'SAFE_TO_CONTINUE') {
        const tri: TriageInput = { patientId: submission.patient.id, narrative: submission.narrative };
        const envelope = createEnvelope(Topics.triage.input, tri, corr);
        await bus.publish(envelope.topic, envelope);
        logger.info('published triage.input', { topic: envelope.topic, correlationId: corr });
        const successAuditDetails = {
          outcome: decision.outcome,
          patientId: tri.patientId,
          practiceId: practiceConfig.practiceId,
          topic: envelope.topic,
        } satisfies Record<string, unknown>;
        recordAudit(AUDIT_SUCCESS_TYPE, corr, successAuditDetails);
        await emitAuditEvent(AUDIT_SUCCESS_TYPE, corr, authContext?.actor ?? null, successAuditDetails);
      } else {
        logger.info('safety diverted submission', { correlationId: corr });
      }

      respondJson(res, 200, decision, corr, setOutcome, 'ok');
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

export function getMessageBusForTest(): MessageBus {
  return bus;
}

export function getPracticeConfig(): ResolvedConfig {
  return practiceConfig;
}

export function getSafetyGateSettings(): { timeoutMs: number; fallback: 'rules' | 'none' } {
  return { timeoutMs: safetyGateTimeoutMs, fallback: safetyGateFallbackMode };
}

export { server };
