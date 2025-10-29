import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  logger,
  setCorrelationId,
  createHistogram,
  createCounter,
  getCounterRecords,
  getHistogramRecords,
} from '@onecare/observability';
import type { BookingAssistedOutcome } from '@onecare/events';
import type { MessageBus } from '@onecare/bus';
import {
  SearchState,
  BookedState,
  deriveBookingIdempotencyKey,
  type BookingContext,
  type BookingFeatureFlags,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} from './application/booking.state';
import type { BookingEvent, BookingAuditPublisher } from './application/booking.state';
import type { EnhancedAccessPolicy } from './application/enhancedAccess';
import type { GpConnectClient, SlotView } from './adapters/gpconnect.client';
import type { FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import { errorEnvelope, mapErrorToStatus, type ErrorCode } from './application/error';
import { validateBookingSearchRequest, validateBookingAssistedOutcome } from './application/contracts';
import { BookingSearchError, BookingAppointmentError } from './application/booking.state';
import { recordAssistedOutcome, AssistedOutcomeError, type AssistedOutcomeCommand } from './application/assisted';

const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_BODY_LIMIT = 128 * 1024;
const DEFAULT_MAX_CONCURRENCY = 20;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const READINESS_CACHE_MIN_MS = 250;
const DEFAULT_READINESS_CACHE_MS = 1_000;
const BOOKING_LATENCY_BUCKETS_MS = [50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000];

const bookingHttpDuration = createHistogram('booking_http_duration_ms');
const bookingHttpRequests = createCounter('booking_http_requests_total');
const bookingHttpBackpressure = createCounter('booking_http_backpressure_total');

export interface BookingServerOptions {
  client: GpConnectClient;
  bus: MessageBus;
  fhirRepository?: FhirRepository;
  queueNotifier?: QueueNotifier;
  auditPublisher?: BookingAuditPublisher;
  enhancedAccessPolicy?: EnhancedAccessPolicy;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  queueName?: string;
  maxConcurrency?: number;
  readinessCheck?: () => Promise<boolean>;
  featureFlags?: BookingFeatureFlags;
}

interface ParsedAppointmentRequest {
  slot: SlotView;
  patientId: string;
  narrative?: string;
  searchParams?: Record<string, unknown>;
  idempotencyKey?: string;
  queueName?: string;
  originatingTaskId?: string;
}

class RequestError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface BookingHttpServer extends http.Server {
  initiateShutdown(timeoutMs?: number): Promise<void>;
}

interface ReadinessStatus {
  ok: boolean;
  reason?: string;
  checkedAt: number;
}

interface ReadinessManager {
  check(): Promise<ReadinessStatus>;
  markShutdown(): void;
  isShuttingDown(): boolean;
  getStatus(): ReadinessStatus | null;
}

function createReadinessManager(options: BookingServerOptions): ReadinessManager {
  const cacheMs = resolveReadinessCacheMs();
  let shuttingDown = false;
  let lastStatus: ReadinessStatus | null = null;
  let inFlight: Promise<ReadinessStatus> | null = null;

  const dependencyProbe = async (): Promise<ReadinessStatus> => {
    if (typeof options.readinessCheck === 'function') {
      try {
        const ok = await options.readinessCheck();
        return { ok: Boolean(ok), reason: ok ? undefined : 'dependency_unavailable', checkedAt: Date.now() };
      } catch (error) {
        return { ok: false, reason: asMessage(error), checkedAt: Date.now() };
      }
    }
    const clientWithHealth = options.client as { checkHealth?: () => Promise<{ ok: boolean; reason?: string }> };
    if (clientWithHealth && typeof clientWithHealth.checkHealth === 'function') {
      try {
        const result = await clientWithHealth.checkHealth();
        return {
          ok: Boolean(result?.ok),
          reason: result?.reason,
          checkedAt: Date.now(),
        };
      } catch (error) {
        return { ok: false, reason: asMessage(error), checkedAt: Date.now() };
      }
    }
    return { ok: true, checkedAt: Date.now() };
  };

  const runCheck = async (): Promise<ReadinessStatus> => {
    const status = await dependencyProbe();
    lastStatus = status;
    return status;
  };

  return {
    async check(): Promise<ReadinessStatus> {
      if (shuttingDown) {
        const status: ReadinessStatus = { ok: false, reason: 'shutting_down', checkedAt: Date.now() };
        lastStatus = status;
        return status;
      }
      const now = Date.now();
      if (lastStatus && now - lastStatus.checkedAt < cacheMs) {
        return lastStatus;
      }
      if (!inFlight) {
        inFlight = runCheck().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    markShutdown(): void {
      shuttingDown = true;
      lastStatus = { ok: false, reason: 'shutting_down', checkedAt: Date.now() };
    },
    isShuttingDown(): boolean {
      return shuttingDown;
    },
    getStatus(): ReadinessStatus | null {
      return lastStatus;
    },
  };
}

export function createBookingServer(options: BookingServerOptions): BookingHttpServer {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  let activeBookings = 0;
  let inflightRequests = 0;
  const sockets = new Set<Socket>();
  let shutdownPromise: Promise<void> | null = null;

  const readiness = createReadinessManager(options);
  void readiness.check().catch(() => undefined);

  const searchState = new SearchState();
  const bookedState = new BookedState();

  const server = http.createServer(async (req, res) => {
    inflightRequests += 1;
    const settle = (): void => {
      inflightRequests = Math.max(0, inflightRequests - 1);
      res.off('finish', settle);
      res.off('close', settle);
    };
    res.on('finish', settle);
    res.on('close', settle);

    const correlationId = ensureCorrelationId(req);
    setCorrelationId(correlationId);
    res.setHeader('x-correlation-id', correlationId);
    const startedAt = performance.now();
    let outcomeRecorded = false;
    const path = normalizePath(req.url);

    const recordOutcome = (outcome: string, status: number): void => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      const durationMs = performance.now() - startedAt;
      bookingHttpDuration.record(durationMs, {
        route: path,
        method: req.method,
        status,
        outcome,
      });
      bookingHttpRequests.add(1, {
        route: path,
        method: req.method,
        status,
        outcome,
      });
    };

    try {
      if (readiness.isShuttingDown() && !(req.method === 'GET' && (path === '/healthz' || path === '/metrics'))) {
        const status = sendJson(res, 503, { ok: false, reason: 'shutting_down' });
        recordOutcome('shutting_down', status);
        return;
      }
      if (req.method === 'GET' && path === '/metrics') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; version=0.0.4');
        res.end(renderPrometheusMetrics());
        return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        const status = sendJson(res, 200, { ok: true });
        recordOutcome('success', status);
        return;
      }
      if (req.method === 'GET' && path === '/readyz') {
        const statusInfo = await readiness.check();
        if (statusInfo.ok) {
          const status = sendJson(res, 200, { ok: true });
          recordOutcome('success', status);
          return;
        }
        logger.warn('booking.readiness.unavailable', {
          reason: statusInfo.reason ?? 'dependency_unavailable',
          correlationId,
        });
        const status = sendJson(res, 503, {
          ok: false,
          reason: statusInfo.reason ?? 'dependency_unavailable',
        });
        recordOutcome('dependency_unavailable', status);
        return;
      }
      if (req.method === 'POST' && path === '/booking/search') {
        const status = await handleSearch(req, res, correlationId, searchState, options);
        recordOutcome(status < 300 ? 'success' : 'client_error', status);
        return;
      }
      if (req.method === 'POST' && path === '/booking/appointments') {
        if (activeBookings >= maxConcurrency) {
          const status = sendError(res, 'too_many_requests', 'Booking concurrency limit reached', correlationId, {
            maxConcurrency,
          });
          bookingHttpBackpressure.add(1, { route: path, method: req.method });
          recordOutcome('backpressure', status);
          return;
        }
        activeBookings += 1;
        try {
          const status = await handleBooking(req, res, correlationId, bookedState, options);
          recordOutcome(status < 300 ? 'success' : status >= 500 ? 'server_error' : 'client_error', status);
        } finally {
          activeBookings = Math.max(0, activeBookings - 1);
        }
        return;
      }
      if (req.method === 'POST' && path === '/booking/assisted') {
        const status = await handleAssistedOutcome(req, res, correlationId, options);
        recordOutcome(status < 300 ? 'success' : status >= 500 ? 'server_error' : 'client_error', status);
        return;
      }

      res.statusCode = 404;
      res.end();
      recordOutcome('not_found', 404);
    } catch (error) {
      const envelope = errorEnvelope('internal_error', 'Unexpected booking error', { reason: asMessage(error) }, correlationId);
      res.statusCode = 500;
      res.setHeader('content-type', JSON_CONTENT_TYPE);
      res.end(JSON.stringify(envelope));
      logger.error('booking.http.unhandled', {
        correlationId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      recordOutcome('unhandled_error', 500);
    } finally {
      if (!outcomeRecorded && res.statusCode) {
        recordOutcome('unknown', res.statusCode);
      }
      setCorrelationId(undefined);
    }
  }) as BookingHttpServer;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.initiateShutdown = async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    readiness.markShutdown();
    shutdownPromise = (async () => {
      logger.warn('booking.shutdown.start', { timeoutMs, inflight: inflightRequests });
      const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (inflightRequests > 0 && Date.now() < deadline) {
        await sleep(50);
      }
      if (inflightRequests > 0) {
        logger.warn('booking.shutdown.force_close', { inflight: inflightRequests });
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore destroy errors
          }
        }
      }
      await closePromise;
      logger.info('booking.shutdown.complete', { inflight: inflightRequests });
    })().finally(() => {
      shutdownPromise = null;
    });
    return shutdownPromise;
  };

  return server;
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  searchState: SearchState,
  options: BookingServerOptions,
): Promise<number> {
  try {
    enforceJsonContentType(req);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendError(res, error.code, error.message, correlationId, error.details);
    }
    throw error;
  }
  const payload = await readJson(req);
  const validation = validateBookingSearchRequest(payload);
  if (!validation.ok) {
    return sendError(res, 'invalid_input', 'Invalid booking search request', correlationId, {
      errors: validation.errors,
    });
  }

  const context = createContext('booking-search', options, correlationId);
  context.searchParams = validation.value as unknown as Record<string, unknown>;
  try {
    await searchState.handle(context, { type: 'booking.search' });
  } catch (error) {
    return handleSearchError(res, error, correlationId);
  }

  const body = context.lastSearchResponse ?? { slots: [] };
  return sendJson(res, 200, body);
}

async function handleBooking(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  bookedState: BookedState,
  options: BookingServerOptions,
): Promise<number> {
  try {
    enforceJsonContentType(req);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendError(res, error.code, error.message, correlationId, error.details);
    }
    throw error;
  }
  const payload = await readJson(req);
  let parsed: ParsedAppointmentRequest;
  try {
    parsed = parseAppointmentRequest(payload);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendError(res, error.code, error.message, correlationId, error.details);
    }
    return sendError(res, 'invalid_input', 'Invalid appointment request', correlationId);
  }

  if (parsed.searchParams) {
    const validation = validateBookingSearchRequest(parsed.searchParams);
    if (!validation.ok) {
      return sendError(res, 'invalid_input', 'Invalid search parameters', correlationId, { errors: validation.errors });
    }
    parsed.searchParams = validation.value as unknown as Record<string, unknown>;
  }

  if (options.featureFlags?.gpConnectBooking === false) {
    return sendError(res, 'forbidden', 'GP Connect booking disabled', correlationId, {
      feature: 'gp_connect_booking',
    });
  }

  const context = createContext(`booking-${parsed.slot.id}`, options, correlationId);
  context.patientId = parsed.patientId;
  context.narrative = parsed.narrative;
  context.searchParams = parsed.searchParams as Record<string, unknown> | undefined;
  context.queueName = parsed.queueName ?? options.queueName ?? 'booking.notifications';
  context.originatingTaskId = parsed.originatingTaskId;
  context.selectedSlot = {
    id: parsed.slot.id,
    start: parsed.slot.start,
    end: parsed.slot.end,
    organisationId: parsed.slot.organisationId,
    serviceType: parsed.slot.serviceType,
  };
  context.slots = [context.selectedSlot];
  context.idempotencyKey = parsed.idempotencyKey ?? req.headers['x-idempotency-key']?.toString();
  if (typeof options.idempotencyTtlSeconds === 'number' && Number.isFinite(options.idempotencyTtlSeconds)) {
    context.idempotencyTtlSeconds = options.idempotencyTtlSeconds;
  }

  if (!context.bus) {
    return sendError(res, 'internal_error', 'Booking bus not configured', correlationId);
  }

  if (!context.idempotencyKey) {
    context.idempotencyKey = deriveBookingIdempotencyKey(context);
  }

  try {
    await bookedState.handle(context, { type: 'booking.book' } satisfies BookingEvent);
  } catch (error) {
    return handleBookingError(res, error, correlationId);
  }

  if (context.lastBookingStatus === 'duplicate') {
    return sendError(
      res,
      'conflict',
      'Booking already processed for this idempotency key',
      correlationId,
      context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : undefined,
    );
  }

  const confirmation = context.appointmentConfirmation;
  if (!confirmation) {
    return sendError(res, 'internal_error', 'Booking confirmation missing', correlationId);
  }

  const responseBody = {
    appointmentId: confirmation.appointmentId,
    slotId: confirmation.slotId,
    correlationId,
    status: 'booked' as const,
  };
  return sendJson(res, 201, responseBody);
}

async function handleAssistedOutcome(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  options: BookingServerOptions,
): Promise<number> {
  try {
    enforceJsonContentType(req);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendError(res, error.code, error.message, correlationId, error.details);
    }
    throw error;
  }

  const rawPayload = await readJson(req);
  const validation = validateBookingAssistedOutcome(rawPayload);
  if (!validation.ok) {
    return sendError(res, 'invalid_input', 'Invalid assisted booking payload', correlationId, {
      errors: validation.errors,
    });
  }

  const command: AssistedOutcomeCommand = {
    ...(validation.value as BookingAssistedOutcome),
    correlationId,
  };

  try {
    const result = await recordAssistedOutcome(command, {
      fhirRepository: options.fhirRepository!,
      bus: options.bus,
      queueNotifier: options.queueNotifier,
      auditPublisher: options.auditPublisher,
      queueName: options.queueName,
    });
    return sendJson(res, 202, {
      status: 'recorded',
      outcome: command.outcome,
      appointmentId: result.appointmentId ?? null,
      taskId: result.taskReference,
    });
  } catch (error) {
    if (error instanceof AssistedOutcomeError) {
      switch (error.code) {
        case 'slot_required':
        case 'slot_required_when_booked':
          return sendError(res, 'invalid_input', 'slot required when outcome is booked', correlationId);
        case 'bus_missing':
        case 'fhir_repository_missing':
          return sendError(res, 'internal_error', 'Booking service misconfigured', correlationId, { code: error.code });
        default:
          break;
      }
    }
    logger.error('booking.assisted.outcome_failed', {
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
    return sendError(res, 'internal_error', 'Failed to record assisted booking outcome', correlationId);
  }
}

function createContext(id: string, options: BookingServerOptions, correlationId: string): BookingContext {
  return {
    id,
    client: options.client,
    correlationId,
    enhancedAccessPolicy: options.enhancedAccessPolicy,
    fhirRepository: options.fhirRepository,
    queueNotifier: options.queueNotifier,
    auditPublisher: options.auditPublisher,
    bus: options.bus,
    idempotencyStore: options.idempotencyStore,
    idempotencyTtlSeconds: options.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    featureFlags: options.featureFlags,
  } as BookingContext;
}

function parseAppointmentRequest(body: unknown): ParsedAppointmentRequest {
  if (!body || typeof body !== 'object') {
    throw new RequestError('invalid_input', 'Appointment request must be an object');
  }
  const source = body as Record<string, unknown>;
  const slot = parseSlot(source.slot);
  const patientId = readString(source.patientId, 'patientId');
  if (!patientId) {
    throw new RequestError('invalid_input', 'patientId is required');
  }

  const narrative = typeof source.narrative === 'string' ? source.narrative : undefined;
  const searchParams = typeof source.searchParams === 'object' ? (source.searchParams as Record<string, unknown>) : undefined;
  const idempotencyKey = typeof source.idempotencyKey === 'string' ? source.idempotencyKey.trim() || undefined : undefined;
  const queueName = typeof source.queueName === 'string' ? source.queueName.trim() || undefined : undefined;
  const originatingTaskId =
    typeof source.originatingTaskId === 'string' ? source.originatingTaskId.trim() || undefined : undefined;

  return {
    slot,
    patientId,
    narrative,
    searchParams,
    idempotencyKey,
    queueName,
    originatingTaskId,
  };
}

function parseSlot(raw: unknown): SlotView {
  if (!raw || typeof raw !== 'object') {
    throw new RequestError('invalid_input', 'slot is required');
  }
  const source = raw as Record<string, unknown>;
  const id = readString(source.id, 'slot.id');
  const start = readString(source.start, 'slot.start');
  const end = readString(source.end, 'slot.end');
  const organisationId = readString(source.organisationId, 'slot.organisationId');
  if (!id || !start || !end || !organisationId) {
    throw new RequestError('invalid_input', 'slot requires id, start, end, and organisationId');
  }
  const serviceType = typeof source.serviceType === 'string' ? source.serviceType : undefined;
  return { id, start, end, organisationId, serviceType };
}

function readString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    logger.warn('booking.http.empty_field', { field });
    return undefined;
  }
  return trimmed;
}

function enforceJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type'];
  if (!contentType) {
    throw new RequestError('unsupported_media_type', 'Missing content-type header');
  }
  if (!contentType.toLowerCase().includes(JSON_CONTENT_TYPE)) {
    throw new RequestError('unsupported_media_type', 'Only application/json is supported');
  }
}

async function readJson(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<unknown>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new RequestError('payload_too_large', 'Request body exceeds limit', { limit }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        reject(new RequestError('invalid_input', 'Invalid JSON payload'));
      }
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): number {
  const normalized = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(normalized);
  return status;
}

function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): number {
  const envelope = errorEnvelope(code, message, details, correlationId);
  res.statusCode = mapErrorToStatus(code);
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(JSON.stringify(envelope));
  return res.statusCode;
}

function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP booking_http_duration_ms Booking HTTP request duration in milliseconds');
  lines.push('# TYPE booking_http_duration_ms histogram');
  const durationLines = renderHistogramMetric('booking_http_duration_ms', BOOKING_LATENCY_BUCKETS_MS, [
    'route',
    'method',
    'status',
    'outcome',
  ]);
  if (durationLines.length === 0) {
    lines.push('booking_http_duration_ms_bucket{le="+Inf"} 0');
    lines.push('booking_http_duration_ms_count 0');
    lines.push('booking_http_duration_ms_sum 0');
  } else {
    lines.push(...durationLines);
  }

  lines.push('# HELP booking_http_requests_total Booking HTTP requests');
  lines.push('# TYPE booking_http_requests_total counter');
  const requestLines = renderCounterMetric('booking_http_requests_total', ['route', 'method', 'status', 'outcome']);
  if (requestLines.length === 0) {
    lines.push('booking_http_requests_total 0');
  } else {
    lines.push(...requestLines);
  }

  lines.push('# HELP booking_http_backpressure_total Booking requests rejected due to backpressure');
  lines.push('# TYPE booking_http_backpressure_total counter');
  const backpressureLines = renderCounterMetric('booking_http_backpressure_total', ['route', 'method', 'status', 'outcome']);
  if (backpressureLines.length === 0) {
    lines.push('booking_http_backpressure_total 0');
  } else {
    lines.push(...backpressureLines);
  }

  lines.push('# HELP booking_event_dlq_total Booking appointment events routed to the DLQ');
  lines.push('# TYPE booking_event_dlq_total counter');
  const eventDlqLines = renderCounterMetric('booking_event_dlq_total', ['topic']);
  if (eventDlqLines.length === 0) {
    lines.push('booking_event_dlq_total 0');
  } else {
    lines.push(...eventDlqLines);
  }

  lines.push('# HELP booking_event_publish_error_total Booking appointment publish errors');
  lines.push('# TYPE booking_event_publish_error_total counter');
  const publishErrorLines = renderCounterMetric('booking_event_publish_error_total', ['stage']);
  if (publishErrorLines.length === 0) {
    lines.push('booking_event_publish_error_total 0');
  } else {
    lines.push(...publishErrorLines);
  }

  return `${lines.join('\n')}\n`;
}

function renderHistogramMetric(name: string, buckets: number[], labelKeys: string[]): string[] {
  const records = getHistogramRecords(name);
  if (records.length === 0) {
    return [];
  }
  const aggregates = new Map<string, { labelPairs: string[]; counts: number[]; sum: number; count: number }>();
  for (const record of records) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const labelPairs = collectLabelPairs(record.attributes ?? {}, labelKeys);
    const key = labelPairs.join(',');
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        labelPairs,
        counts: new Array(buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      aggregates.set(key, aggregate);
    }
    let bucketIndex = buckets.findIndex((boundary) => value <= boundary);
    if (bucketIndex === -1) bucketIndex = buckets.length;
    aggregate.counts[bucketIndex] += 1;
    aggregate.sum += value;
    aggregate.count += 1;
  }

  const lines: string[] = [];
  for (const aggregate of Array.from(aggregates.values()).sort((a, b) => a.labelPairs.join(',').localeCompare(b.labelPairs.join(',')))) {
    const baseLabels = aggregate.labelPairs;
    let cumulative = 0;
    buckets.forEach((boundary, idx) => {
      cumulative += aggregate.counts[idx];
      const labels = formatLabelText([...baseLabels, `le="${boundary}"`]);
      lines.push(`${name}_bucket${labels} ${cumulative}`);
    });
    cumulative += aggregate.counts[aggregate.counts.length - 1];
    const infLabels = formatLabelText([...baseLabels, 'le="+Inf"']);
    lines.push(`${name}_bucket${infLabels} ${cumulative}`);
    const countLabels = formatLabelText(baseLabels);
    lines.push(`${name}_count${countLabels} ${aggregate.count}`);
    lines.push(`${name}_sum${countLabels} ${aggregate.sum.toFixed(6)}`);
  }

  return lines;
}

function renderCounterMetric(name: string, labelKeys: string[]): string[] {
  const records = getCounterRecords(name);
  if (records.length === 0) {
    return [];
  }
  const totals = new Map<string, { labelPairs: string[]; value: number }>();
  for (const record of records) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const labelPairs = collectLabelPairs(record.attributes ?? {}, labelKeys);
    const key = labelPairs.join(',');
    const existing = totals.get(key);
    if (existing) {
      existing.value += value;
    } else {
      totals.set(key, { labelPairs, value });
    }
  }

  return Array.from(totals.values())
    .sort((a, b) => a.labelPairs.join(',').localeCompare(b.labelPairs.join(',')))
    .map((entry) => `${name}${formatLabelText(entry.labelPairs)} ${entry.value}`);
}

function collectLabelPairs(attributes: Record<string, unknown>, keys: string[]): string[] {
  const pairs: string[] = [];
  for (const key of keys) {
    const raw = attributes[key];
    if (raw === undefined || raw === null) continue;
    pairs.push(`${key}="${escapeLabelValue(raw)}"`);
  }
  return pairs;
}

function escapeLabelValue(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatLabelText(pairs: string[]): string {
  if (pairs.length === 0) {
    return '';
  }
  return `{${pairs.join(',')}}`;
}

function handleSearchError(res: ServerResponse, error: unknown, correlationId: string): number {
  if (error instanceof BookingSearchError) {
    switch (error.code) {
      case 'booking.search.invalid_params':
        return sendError(res, 'invalid_input', 'Invalid booking search request', correlationId);
      case 'booking.search.unavailable':
        return sendError(res, 'upstream_unavailable', 'GP Connect unavailable', correlationId);
      default:
        return sendError(res, 'upstream_unavailable', 'Booking search failed', correlationId);
    }
  }
  return sendError(res, 'internal_error', 'Booking search failed', correlationId);
}

function handleBookingError(res: ServerResponse, error: unknown, correlationId: string): number {
  if (error instanceof BookingAppointmentError) {
    switch (error.code) {
      case 'booking.create.conflict':
        return sendError(res, 'conflict', 'Appointment slot already booked', correlationId);
      case 'booking.create.unavailable':
        return sendError(res, 'upstream_unavailable', 'GP Connect unavailable', correlationId);
      case 'booking.create.event_failed':
        return sendError(res, 'upstream_unavailable', 'Failed to publish booking event', correlationId);
      case 'booking.create.invalid_event':
        return sendError(res, 'internal_error', 'Appointment payload invalid', correlationId);
      default:
        return sendError(res, 'internal_error', 'Booking failed', correlationId);
    }
  }
  return sendError(res, 'internal_error', 'Booking failed', correlationId);
}

function normalizePath(url: string | undefined): string {
  if (!url) return '/';
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

function ensureCorrelationId(req: IncomingMessage): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header) && header.length > 0) {
    const candidate = header[0]?.trim();
    if (candidate) return candidate;
  }
  return randomUUID();
}

function resolveReadinessCacheMs(): number {
  const raw = Number(process.env.BOOKING_READINESS_CACHE_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_READINESS_CACHE_MS;
  }
  return Math.max(READINESS_CACHE_MIN_MS, Math.floor(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asMessage(value: unknown): string {
  if (!value) return 'unknown_error';
  if (value instanceof Error) return value.message;
  return String(value);
}
