import * as http from 'http';
import { randomUUID } from 'node:crypto';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus, redact } from './application/error';
import { callWithGuard } from './adapters/services/callWithGuard';
import { validatePortalSubmission } from './application/validator';
import { getBus, markNatsBusConnected } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { createEnvelope, PortalSubmission, Topics, TriageInput, AuditEvent } from '@onecare/events';
import { initTracing, logger, setCorrelationId, withCorrelationContext } from '@onecare/observability';
import { deriveIdempotencyKey, reserveIdempotency, releaseIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';
import type { AuthContext } from '@onecare/security';
import { getSecurityServices } from './adapters/security';
import { loadConfig, type ResolvedConfig } from '@onecare/config';
import { createAuditEvent, getAuditLedger } from './adapters/audit';
import { InMemoryFeatureStore } from '@onecare/feature-store-memory';
import type { FeatureStore, IdempotencyStore } from '@onecare/ports';
import { normalizeToFhir, validateProfiles } from './application/normalize';
import { resolveServerPort } from './support/port';

const port = resolveServerPort();
const wantsNats = Boolean(process.env.NATS_URL && process.env.NATS_URL.trim().length > 0);
const practiceId = process.env.PRACTICE_ID?.trim() || 'demo';
const practiceConfig: ResolvedConfig = loadConfig(practiceId);
const safetyGateSettings = practiceConfig.safety_gate ?? {};
const safetyGateTimeoutMs = safetyGateSettings.timeout_ms ?? 800;
const safetyGateFallbackMode = safetyGateSettings.fallback ?? 'rules';
const idempotencyConfig = practiceConfig.idempotency ?? { ttlSeconds: 600 };
const idempotencyTtlSeconds = idempotencyConfig.ttlSeconds;
const bookingAvailabilityTimeoutMs = Number(process.env.BOOKING_AVAILABILITY_TIMEOUT_MS ?? '3000');
const bookingAvailabilityBase = (() => {
  const raw = process.env.BOOKING_AVAILABILITY_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      logger.warn('booking availability upstream rejected - invalid protocol', { value: raw });
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn('booking availability upstream rejected - invalid URL', {
      value: raw,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
})();

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const featureLoggingOn = parseBooleanFlag(process.env.FEATURE_LOGGING);
let featureStore: FeatureStore | null = featureLoggingOn ? new InMemoryFeatureStore() : null;

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
  idempotency: {
    ttlSeconds: idempotencyTtlSeconds,
  },
});

void initTracing('orchestrator').catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn('failed to initialize tracing', { message });
});

let bus: MessageBus = getBus();
markNatsBusConnected(bus, !wantsNats);
let idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore();
let busReady = !wantsNats;
let _natsConn: NatsConnection | null = null;
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

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map((segment) => Number(segment));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

function normalizeAttachmentUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError('invalid_input', 'Attachment URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpError('invalid_input', 'Attachment URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError('invalid_input', 'Attachment URL must not include credentials');
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new HttpError('invalid_input', 'Attachment hostname is missing');
  }
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new HttpError('invalid_input', 'Attachment hostname is not allowed');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isPrivateIpv4(hostname)) {
    throw new HttpError('invalid_input', 'Attachment host is not reachable');
  }
  if (/^[0-9a-fA-F:]+$/.test(hostname) && isPrivateIpv6(hostname)) {
    throw new HttpError('invalid_input', 'Attachment host is not reachable');
  }
  return parsed.toString();
}

function sanitizeInboundSubmission(submission: PortalSubmission): void {
  if (!Array.isArray(submission.attachments) || submission.attachments.length === 0) {
    if ('attachments' in submission) {
      delete (submission as { attachments?: PortalSubmission['attachments'] }).attachments;
    }
    return;
  }
  const sanitized: NonNullable<PortalSubmission['attachments']> = [];
  for (const raw of submission.attachments) {
    const contentType = typeof raw?.contentType === 'string' ? raw.contentType.trim() : '';
    const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
    if (!contentType || !url) {
      throw new HttpError('invalid_input', 'Attachment fields are required');
    }
    const safeUrl = normalizeAttachmentUrl(url);
    sanitized.push({
      contentType,
      url: safeUrl,
    });
  }
  if (sanitized.length > 0) {
    submission.attachments = sanitized;
  } else {
    delete (submission as { attachments?: PortalSubmission['attachments'] }).attachments;
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
    _natsConn = conn;
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
  return randomUUID();
}

function resolveMaxBodyBytes(): number {
  const parsed = parseByteSize(process.env.MAX_BODY_BYTES);
  if (!parsed) {
    return 256 * 1024;
  }
  return parsed;
}

function parseByteSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmMgG]?)(?:[bB])?$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  const bytes = value * multiplier;
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.floor(bytes);
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

function recordHttpMetrics(route: string, outcome: RequestOutcome, durationMs: number, correlationId: string | undefined): void {
  logger.info('metric.http.request', {
    route,
    outcome,
    durationMs: Number(durationMs.toFixed(2)),
    correlationId,
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
    recordHttpMetrics(route, outcome, durationMs, correlationId);
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

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const abort = (err: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.on('data', () => {});
      req.resume();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        abort(new HttpError('payload_too_large', `Payload exceeds limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpError('internal_error', 'Failed to read request body', { reason: err.message }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
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

function recordIdempotencyHit(key: string, correlationId: string | undefined): void {
  logger.info('metric.idempotency.hit', {
    key,
    correlationId,
  });
}

function recordIdempotencyMiss(key: string, correlationId: string | undefined): void {
  logger.info('metric.idempotency.miss', {
    key,
    correlationId,
  });
}

function recordIdempotencyTtl(ttlSeconds: number, correlationId: string | undefined): void {
  logger.info('metric.idempotency.ttl', {
    ttlSeconds,
    correlationId,
  });
}

function classifyErrorCode(err: unknown): string | undefined {
  if (!err) return undefined;
  const code = (err as { code?: string; name?: string }).code ?? (err as { name?: string }).name;
  return code ? String(code).toLowerCase() : undefined;
}

interface FeatureLogEntry {
  source: 'triage' | 'safety';
  entityId?: string | null;
  patientId?: string | null;
  correlationId?: string | null;
  features?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | number | Date | null;
}

interface FeatureLogRequestBody {
  source?: unknown;
  entityId?: unknown;
  patientId?: unknown;
  correlationId?: unknown;
  features?: unknown;
  metadata?: unknown;
  recordedAt?: unknown;
}

function buildFeatureLogKey(entry: FeatureLogEntry): string {
  const parts: string[] = [entry.source];
  if (entry.entityId) {
    parts.push(entry.entityId);
  }
  if (entry.correlationId) {
    parts.push(entry.correlationId);
  } else {
    parts.push(String(Date.now()));
  }
  return parts.join(':');
}

async function logFeatureRecord(entry: FeatureLogEntry): Promise<void> {
  if (!featureLoggingOn || !featureStore) {
    return;
  }

  const record = {
    source: entry.source,
    recordedAt: entry.occurredAt ? new Date(entry.occurredAt).toISOString() : new Date().toISOString(),
    correlationId: entry.correlationId ?? null,
    patientId: entry.patientId ?? null,
    metadata: entry.metadata ?? {},
    features: entry.features ?? {},
  } satisfies Record<string, unknown>;

  const key = buildFeatureLogKey(entry);
  try {
    await featureStore.putFeatures(key, record);
    logger.debug('feature record stored', {
      key,
      source: entry.source,
      correlationId: entry.correlationId,
    });
  } catch (err) {
    logger.warn('feature record storage failed', {
      key,
      source: entry.source,
      correlationId: entry.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getFeatureStoreForTest(): FeatureStore | null {
  return featureStore;
}

export function setFeatureStoreForTest(store: FeatureStore | null): void {
  featureStore = store;
}

const server = http.createServer((req, res) => withCorrelationContext(() => {
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
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/booking/slots') {
    const routeLabel = 'GET /booking/slots';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!bookingAvailabilityBase) {
        respondError(res, 'upstream_unavailable', 'Booking availability service not configured', corr, setOutcome);
        return;
      }

      const upstreamUrl = new URL('slots', bookingAvailabilityBase);
      upstreamUrl.search = parsedUrl?.search ?? '';

      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-correlation-id': corr,
      };
      const authHeader = getHeader(req.headers, 'authorization');
      if (authHeader) {
        headers.authorization = authHeader;
      }
      const practiceHeader = getHeader(req.headers, 'x-practice-id');
      if (practiceHeader) {
        headers['x-practice-id'] = practiceHeader;
      }

      const controller = new AbortController();
      const timeoutMs = Number.isFinite(bookingAvailabilityTimeoutMs) && bookingAvailabilityTimeoutMs > 0
        ? bookingAvailabilityTimeoutMs
        : 3000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          throw new HttpError('upstream_timeout', 'Booking availability request timed out');
        }
        throw new HttpError('upstream_unavailable', 'Booking availability request failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const bodyText = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('cache-control', 'no-store, max-age=0');
      const upstreamContentType = upstream.headers.get('content-type');
      if (upstreamContentType) {
        res.setHeader('content-type', upstreamContentType);
      } else {
        res.setHeader('content-type', 'application/json');
      }
      const upstreamCorrelation = upstream.headers.get('x-correlation-id');
      if (upstreamCorrelation) {
        res.setHeader('x-upstream-correlation-id', upstreamCorrelation);
      }
      res.end(bodyText);

      if (!upstream.ok) {
        setOutcome(upstream.status >= 500 ? 'upstream_unavailable' : 'invalid_input');
      } else {
        setOutcome('ok');
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/feature-log') {
    const routeLabel = 'POST /feature-log';
    handleHttp(req, res, routeLabel, corr, async () => {
      if (!featureLoggingOn || !featureStore) {
        res.statusCode = 202;
        res.end('feature logging disabled');
        return;
      }

      const rawBuf = await readRequestBody(req, 64 * 1024);
      let payload: FeatureLogRequestBody;
      try {
        payload = JSON.parse(rawBuf.toString('utf8')) as FeatureLogRequestBody;
      } catch {
        throw new HttpError('invalid_input', 'Invalid JSON body');
      }

      if (!payload || typeof payload !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }

      const source = payload.source;
      if (source !== 'triage' && source !== 'safety') {
        throw new HttpError('invalid_input', 'Invalid source');
      }

      const entityId = typeof payload.entityId === 'string' && payload.entityId.trim().length > 0 ? payload.entityId : null;
      const patientId =
        typeof payload.patientId === 'string' && payload.patientId.trim().length > 0 ? payload.patientId : entityId;
      const correlationId =
        typeof payload.correlationId === 'string' && payload.correlationId.trim().length > 0 ? payload.correlationId : corr;

      const features =
        payload.features && typeof payload.features === 'object' ? (payload.features as Record<string, unknown>) : {};
      const metadata =
        payload.metadata && typeof payload.metadata === 'object' ? (payload.metadata as Record<string, unknown>) : {};

      let recordedAt: string | number | undefined;
      if (typeof payload.recordedAt === 'string' || typeof payload.recordedAt === 'number') {
        recordedAt = payload.recordedAt;
      }

      await logFeatureRecord({
        source,
        entityId,
        patientId,
        correlationId,
        features,
        metadata,
        occurredAt: recordedAt ?? Date.now(),
      });

      res.statusCode = 202;
      res.end('accepted');
    });
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/safety-check') {
    const routeLabel = 'POST /safety-check';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!busReady) {
        req.resume();
        respondError(res, 'upstream_unavailable', 'Event bus unavailable', corr, setOutcome);
        return;
      }

      const maxBytes = resolveMaxBodyBytes();
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

      sanitizeInboundSubmission(submission);

      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr;
      const authHeader = getHeader(req.headers, 'authorization');
      const authContext = buildAuthContext(req.headers);
      const explicitKeyHeader = req.headers['x-idempotency-key'];
      const explicitKey = Array.isArray(explicitKeyHeader) ? explicitKeyHeader[0] : explicitKeyHeader;
      const idemKey = deriveIdempotencyKey(submission, authContext?.actor?.id, explicitKey);
      const replayFingerprint = `${requestId}:${idemKey}`;
      let reservationActive = false;
      const releaseReservation = async () => {
        if (!reservationActive) return;
        try {
          await releaseIdempotency(idempotencyStore, idemKey);
          logger.info('idempotency.released', { key: idemKey, correlationId: corr });
        } catch (releaseError) {
          logger.warn('idempotency.release_failed', {
            key: idemKey,
            correlationId: corr,
            reason: releaseError instanceof Error ? releaseError.message : releaseError,
          });
        } finally {
          reservationActive = false;
        }
      };
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

      if (!(await security.verifySignatureAndReplayGuard(authHeader, replayFingerprint))) {
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

      res.setHeader('x-idempotency-key', idemKey);
      logger.info('idempotency.key.derived', { key: idemKey, correlationId: corr });

      const idemResult = await reserveIdempotency(idempotencyStore, idemKey, {
        ttlSeconds: idempotencyTtlSeconds,
      });
      if (idemResult === 'exists') {
        recordIdempotencyHit(idemKey, corr);
        logger.info('idempotency.hit', { key: idemKey, correlationId: corr });
        respondError(res, 'conflict', 'Duplicate request', corr, setOutcome, { idempotencyKey: idemKey });
        return;
      }
      reservationActive = true;
      recordIdempotencyMiss(idemKey, corr);
      recordIdempotencyTtl(idempotencyTtlSeconds, corr);
      logger.info('idempotency.reserved', { key: idemKey, correlationId: corr, ttlSeconds: idempotencyTtlSeconds });

      try {
        let decision: Awaited<ReturnType<typeof analyzePortalSubmission>>;
        try {
          decision = await callWithGuard(
            'safety_gate',
            (signal) =>
              analyzePortalSubmission(submission, undefined, {
                correlationId: corr,
                signal,
              }),
            {
              timeoutMs: safetyGateTimeoutMs,
              maxRetries: 1,
              baseDelayMs: 10,
              correlationId: corr,
            }
          );
        } catch (err) {
          const code = classifyErrorCode(err);
          if (code === 'circuit_open' && safetyGateFallbackMode === 'rules') {
            logger.warn('safety.fallback.rules', { correlationId: corr });
            recordAudit('orchestrator.safety.fallback', corr, { mode: 'rules' });
            decision = { outcome: 'SAFE_TO_CONTINUE', reason: 'FALLBACK_RULES' };
          } else {
            throw err;
          }
        }

        if (decision.outcome === 'SAFE_TO_CONTINUE') {
          const bundle = normalizeToFhir(submission);
          try {
            await validateProfiles(bundle);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            recordAudit('orchestrator.validation.failure', corr, { reason });
            await releaseReservation();
            respondError(res, 'invalid_fhir', 'FHIR validation failed', corr, setOutcome);
            return;
          }
          logger.info('bundle.normalized', { entries: bundle.entry.length, correlationId: corr });
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

        reservationActive = false;
        respondJson(res, 200, decision, corr, setOutcome, 'ok');
      } catch (err) {
        await releaseReservation();
        throw err;
      }
    });
    return;
  }
  res.statusCode = 200;
  res.end('orchestrator skeleton');
}));

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

export function setIdempotencyStoreForTest(store: IdempotencyStore): void {
  idempotencyStore = store;
}

export function resetIdempotencyStoreForTest(): void {
  idempotencyStore = new InMemoryIdempotencyStore();
}

export { server };
