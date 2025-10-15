import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger, setCorrelationId } from '@onecare/observability';
import {
  SearchState,
  BookedState,
  deriveBookingIdempotencyKey,
  type BookingContext,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} from './application/booking.state';
import type { BookingEvent, BookingAuditPublisher } from './application/booking.state';
import type { EnhancedAccessPolicy } from './application/enhancedAccess';
import type { GpConnectClient, SlotView } from './adapters/gpconnect.client';
import type { FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import { errorEnvelope, mapErrorToStatus, type ErrorCode } from './application/error';
import { validateBookingSearchRequest } from './application/contracts';
import { BookingSearchError, BookingAppointmentError } from './application/booking.state';

const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_BODY_LIMIT = 128 * 1024;
const DEFAULT_MAX_CONCURRENCY = 20;

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

export function createBookingServer(options: BookingServerOptions): http.Server {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  let activeBookings = 0;

  const searchState = new SearchState();
  const bookedState = new BookedState();

  return http.createServer(async (req, res) => {
    const correlationId = ensureCorrelationId(req);
    setCorrelationId(correlationId);
    res.setHeader('x-correlation-id', correlationId);

    try {
      const path = normalizePath(req.url);
      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/readyz') {
        const ready = await evaluateReadiness(options);
        if (ready) {
          return sendJson(res, 200, { ok: true });
        }
        return sendError(res, 'upstream_unavailable', 'Booking dependencies unavailable', correlationId);
      }
      if (req.method === 'POST' && path === '/booking/search') {
        await handleSearch(req, res, correlationId, searchState, options);
        return;
      }
      if (req.method === 'POST' && path === '/booking/appointments') {
        if (activeBookings >= maxConcurrency) {
          sendError(res, 'too_many_requests', 'Booking concurrency limit reached', correlationId, {
            maxConcurrency,
          });
          return;
        }
        activeBookings += 1;
        try {
          await handleBooking(req, res, correlationId, bookedState, options);
        } finally {
          activeBookings = Math.max(0, activeBookings - 1);
        }
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (error) {
      const envelope = errorEnvelope('internal_error', 'Unexpected booking error', { reason: asMessage(error) }, correlationId);
      res.statusCode = 500;
      res.setHeader('content-type', JSON_CONTENT_TYPE);
      res.end(JSON.stringify(envelope));
      logger.error('booking.http.unhandled', {
        correlationId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    } finally {
      setCorrelationId(undefined);
    }
  });
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  searchState: SearchState,
  options: BookingServerOptions,
): Promise<void> {
  enforceJsonContentType(req);
  const payload = await readJson(req);
  const validation = validateBookingSearchRequest(payload);
  if (!validation.ok) {
    sendError(res, 'invalid_input', 'Invalid booking search request', correlationId, {
      errors: validation.errors,
    });
    return;
  }

  const context = createContext('booking-search', options, correlationId);
  context.searchParams = validation.value as unknown as Record<string, unknown>;
  try {
    await searchState.handle(context, { type: 'booking.search' });
  } catch (error) {
    handleSearchError(res, error, correlationId);
    return;
  }

  const body = context.lastSearchResponse ?? { slots: [] };
  sendJson(res, 200, body);
}

async function handleBooking(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  bookedState: BookedState,
  options: BookingServerOptions,
): Promise<void> {
  enforceJsonContentType(req);
  const payload = await readJson(req);
  let parsed: ParsedAppointmentRequest;
  try {
    parsed = parseAppointmentRequest(payload);
  } catch (error) {
    if (error instanceof RequestError) {
      sendError(res, error.code, error.message, correlationId, error.details);
      return;
    }
    sendError(res, 'invalid_input', 'Invalid appointment request', correlationId);
    return;
  }

  if (parsed.searchParams) {
    const validation = validateBookingSearchRequest(parsed.searchParams);
    if (!validation.ok) {
      sendError(res, 'invalid_input', 'Invalid search parameters', correlationId, { errors: validation.errors });
      return;
    }
    parsed.searchParams = validation.value as unknown as Record<string, unknown>;
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
    sendError(res, 'internal_error', 'Booking bus not configured', correlationId);
    return;
  }

  if (!context.idempotencyKey) {
    context.idempotencyKey = deriveBookingIdempotencyKey(context);
  }

  try {
    await bookedState.handle(context, { type: 'booking.book' } satisfies BookingEvent);
  } catch (error) {
    handleBookingError(res, error, correlationId);
    return;
  }

  if (context.lastBookingStatus === 'duplicate') {
    sendError(
      res,
      'conflict',
      'Booking already processed for this idempotency key',
      correlationId,
      context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : undefined,
    );
    return;
  }

  const confirmation = context.appointmentConfirmation;
  if (!confirmation) {
    sendError(res, 'internal_error', 'Booking confirmation missing', correlationId);
    return;
  }

  const responseBody = {
    appointmentId: confirmation.appointmentId,
    slotId: confirmation.slotId,
    correlationId,
    status: 'booked' as const,
  };
  sendJson(res, 201, responseBody);
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const normalized = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(normalized);
}

function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): void {
  const envelope = errorEnvelope(code, message, details, correlationId);
  res.statusCode = mapErrorToStatus(code);
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(JSON.stringify(envelope));
}

function handleSearchError(res: ServerResponse, error: unknown, correlationId: string): void {
  if (error instanceof BookingSearchError) {
    switch (error.code) {
      case 'booking.search.invalid_params':
        sendError(res, 'invalid_input', 'Invalid booking search request', correlationId);
        return;
      case 'booking.search.unavailable':
        sendError(res, 'upstream_unavailable', 'GP Connect unavailable', correlationId);
        return;
      default:
        sendError(res, 'upstream_unavailable', 'Booking search failed', correlationId);
        return;
    }
  }
  sendError(res, 'internal_error', 'Booking search failed', correlationId);
}

function handleBookingError(res: ServerResponse, error: unknown, correlationId: string): void {
  if (error instanceof BookingAppointmentError) {
    switch (error.code) {
      case 'booking.create.conflict':
        sendError(res, 'conflict', 'Appointment slot already booked', correlationId);
        return;
      case 'booking.create.unavailable':
        sendError(res, 'upstream_unavailable', 'GP Connect unavailable', correlationId);
        return;
      case 'booking.create.event_failed':
        sendError(res, 'upstream_unavailable', 'Failed to publish booking event', correlationId);
        return;
      case 'booking.create.invalid_event':
        sendError(res, 'internal_error', 'Appointment payload invalid', correlationId);
        return;
      default:
        sendError(res, 'internal_error', 'Booking failed', correlationId);
        return;
    }
  }
  sendError(res, 'internal_error', 'Booking failed', correlationId);
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

async function evaluateReadiness(options: BookingServerOptions): Promise<boolean> {
  if (typeof options.readinessCheck === 'function') {
    try {
      return await options.readinessCheck();
    } catch (error) {
      logger.warn('booking.readiness.check_failed', {
        reason: asMessage(error),
      });
      return false;
    }
  }
  return true;
}

function asMessage(value: unknown): string {
  if (!value) return 'unknown_error';
  if (value instanceof Error) return value.message;
  return String(value);
}
