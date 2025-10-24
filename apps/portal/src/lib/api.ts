import type { BookingModality, BookingQueryFilters, BookingSlot } from './booking';
import type { ErrorEnvelope, PortalSubmission, SafetyDecision } from './types';
import type { ErrorObject } from '@onecare/events/src/contracts/error-envelope';
import { getJson, postJson, HttpError } from './dataClient';
import { createCorrelationId, getSessionCorrelationId } from './telemetry';

export interface SubmitIntakeOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
  locale?: string;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    jitter?: boolean;
  };
  onRetry?: (state: { attempt: number; maxRetries: number; correlationId?: string }) => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_BOOKING_TIMEOUT_MS = 3_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 4_000;

const KNOWN_ERROR_CODES: readonly ErrorObject['code'][] = [
  'unauthorized',
  'forbidden',
  'invalid_input',
  'not_found',
  'unsupported_media_type',
  'payload_too_large',
  'conflict',
  'upstream_timeout',
  'upstream_unavailable',
  'internal_error',
  'too_many_requests',
  'rate_limited',
  'busy',
  'over_capacity',
  'invalid_fhir'
] as const;

const isKnownErrorCode = (code: string | undefined): code is ErrorObject['code'] =>
  (KNOWN_ERROR_CODES as readonly string[]).includes(code ?? '');

const resolveOrchestratorBaseUrl = (override?: string): string =>
  override ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';

const resolveBookingBaseUrl = (override?: string): string =>
  override ?? import.meta.env.VITE_BOOKING_API_URL ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';

export interface FetchBookingSlotsOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
  correlationId?: string;
}

const normalizeBookingModality = (
  value: unknown
): { canonical: BookingModality; raw: string } | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const canonical = normalized.replace(/[\s-]+/g, '_');
  if (canonical === 'phone' || canonical === 'telephone') {
    return { canonical: 'phone', raw: value.trim() };
  }
  if (canonical === 'in_person' || canonical === 'inperson' || canonical === 'in_person_visit') {
    return { canonical: 'in_person', raw: value.trim() };
  }
  return { canonical: 'unknown', raw: value.trim() };
};

const normalizeBookingSlot = (value: unknown): BookingSlot | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const start = typeof record.start === 'string' ? record.start : undefined;
  const end = typeof record.end === 'string' ? record.end : undefined;
  const modality = normalizeBookingModality(record.modality);
  const serviceType = typeof record.serviceType === 'string' ? record.serviceType.trim() : undefined;

  if (!id || !start || !end || !modality) {
    return null;
  }

  const location = typeof record.location === 'string' && record.location.trim().length > 0
    ? record.location.trim()
    : undefined;

  return {
    id,
    start,
    end,
    modality: modality.canonical,
    originalModality: modality.canonical === 'unknown' ? modality.raw : undefined,
    serviceType: serviceType && serviceType.length > 0 ? serviceType : undefined,
    location
  };
};

const extractBookingErrorMessage = (error: HttpError): string => {
  const body = error.body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    const rawError = record.error;
    if (rawError && typeof rawError === 'object') {
      const message = (rawError as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message;
      }
    }
  }
  if (error.status === 408) {
    return 'The booking availability request timed out.';
  }
  return `Failed to load booking slots (status ${error.status})`;
};

export const fetchBookingSlots = async (
  filters: BookingQueryFilters = {},
  options: FetchBookingSlotsOptions = {}
): Promise<BookingSlot[]> => {
  const baseUrl = resolveBookingBaseUrl(options.baseUrl);
  const params = new URLSearchParams();

  if (filters.modality) {
    params.set('modality', filters.modality);
  }
  if (filters.from) {
    params.set('from', filters.from);
  }
  if (filters.to) {
    params.set('to', filters.to);
  }
  if (filters.serviceType) {
    params.set('serviceType', filters.serviceType);
  }
  if (filters.location) {
    params.set('location', filters.location);
  }

  const query = params.toString();
  const path = query ? `booking/slots?${query}` : 'booking/slots';

  try {
    const payload = await getJson<unknown>(path, {
      baseUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_BOOKING_TIMEOUT_MS,
      correlationId: options.correlationId,
      cacheKey: `booking:${baseUrl.replace(/\/$/, '')}:${path}`,
      cacheTtlMs: 30_000,
      retry: { maxRetries: 1, baseDelayMs: 200, jitter: true }
    });

    const rawSlots = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { slots?: unknown[] } | undefined)?.slots)
        ? (payload as { slots: unknown[] }).slots
        : [];

    return rawSlots
      .map(normalizeBookingSlot)
      .filter((slot): slot is BookingSlot => slot !== null);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new Error(extractBookingErrorMessage(error));
    }
    throw error;
  }
};

const mapStatusToErrorCode = (status: number): ErrorObject['code'] | null => {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_input';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'unsupported_media_type';
    case 408:
      return 'upstream_timeout';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'too_many_requests';
    case 503:
      return 'upstream_unavailable';
    default:
      return null;
  }
};

const normalizeErrorEnvelopeFromHttpError = (error: HttpError): ErrorEnvelope => {
  const fallback = {
    error: {
      code: 'internal_error' as ErrorObject['code'],
      message: error.message || 'We could not complete the request.',
      correlationId: error.correlationId ?? getSessionCorrelationId()
    }
  } satisfies ErrorEnvelope;

  const body = error.body;
  if (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)) {
    const candidate = (body as ErrorEnvelope).error;
    if (candidate && typeof candidate === 'object') {
      const normalizedCode = isKnownErrorCode(candidate.code) ? candidate.code : 'internal_error';
      return {
        error: {
          code: normalizedCode,
          message: typeof candidate.message === 'string' && candidate.message.trim().length > 0
            ? candidate.message
            : fallback.error.message,
          correlationId: candidate.correlationId ?? error.correlationId ?? getSessionCorrelationId(),
          details: candidate.details
        }
      } satisfies ErrorEnvelope;
    }
  }

  if (error.status === 408) {
    return {
      error: {
        code: 'upstream_timeout',
        message: 'The request timed out before completing.',
        correlationId: error.correlationId ?? getSessionCorrelationId()
      }
    } satisfies ErrorEnvelope;
  }

  if (error.status === 429) {
    return {
      error: {
        code: 'too_many_requests',
        message: 'Please wait a moment before trying again.',
        correlationId: error.correlationId ?? getSessionCorrelationId()
      }
    } satisfies ErrorEnvelope;
  }

  if (error.status === 503) {
    return {
      error: {
        code: 'upstream_unavailable',
        message: 'The service is temporarily unavailable.',
        correlationId: error.correlationId ?? getSessionCorrelationId()
      }
    } satisfies ErrorEnvelope;
  }

  const mappedCode = mapStatusToErrorCode(error.status);
  if (mappedCode) {
    return {
      error: {
        code: mappedCode,
        message: fallback.error.message,
        correlationId: fallback.error.correlationId
      }
    };
  }

  return fallback;
};

export interface SubmitIntakeResult {
  decision: SafetyDecision;
  correlationId?: string;
}

export const submitIntake = async (
  payload: PortalSubmission,
  options: SubmitIntakeOptions = {}
): Promise<SubmitIntakeResult> => {
  const baseUrl = resolveOrchestratorBaseUrl(options.baseUrl);
  const correlationId = createCorrelationId();
  const requestId = createCorrelationId();

  try {
    const { data, response } = await postJson<SafetyDecision>('safety-check', {
      baseUrl,
      body: payload,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      correlationId,
      requestId,
      headers: options.locale ? { 'accept-language': options.locale } : undefined,
      retry: options.retry,
      onRetry: options.onRetry
        ? ({ attempt, maxRetries }) => options.onRetry?.({ attempt, maxRetries, correlationId })
        : undefined
    });

    const responseCorrelation = response.headers.get('x-correlation-id') ?? correlationId;
    return {
      decision: data,
      correlationId: responseCorrelation
    };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      const abortError = error as Error & { __clientCancelled?: boolean };
      abortError.__clientCancelled = true;
      throw abortError;
    }
    if (error instanceof HttpError) {
      const envelope = normalizeErrorEnvelopeFromHttpError(error);
      const enhanced = Object.assign(new Error(envelope.error.message ?? 'Request failed'), {
        envelope
      });
      throw enhanced;
    }
    throw error;
  }
};

export interface BookingApiError extends Error {
  status?: number;
  code?: string;
  correlationId?: string;
  retryAfterSeconds?: number;
  envelope?: ErrorEnvelope;
}

export interface ConfirmBookingPayload {
  slotId: string;
  patientId: string;
  reason?: string;
}

export interface ConfirmBookingResult {
  appointmentId: string;
  slotId: string;
  start: string;
  end: string;
  correlationId?: string;
}

export interface ConfirmBookingOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  idempotencyKey: string;
  correlationId?: string;
  timeoutMs?: number;
}

const normalizeConfirmResponse = (value: unknown): Omit<ConfirmBookingResult, 'correlationId'> | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const appointmentId = typeof record.appointmentId === 'string' ? record.appointmentId : undefined;
  const slotId = typeof record.slotId === 'string' ? record.slotId : undefined;
  const start = typeof record.start === 'string' ? record.start : undefined;
  const end = typeof record.end === 'string' ? record.end : undefined;

  if (!appointmentId || !slotId || !start || !end) {
    return null;
  }

  return {
    appointmentId,
    slotId,
    start,
    end
  };
};

const normalizeBookingApiError = (error: HttpError): BookingApiError => {
  const bookingError: BookingApiError = Object.assign(new Error(error.message), {
    status: error.status,
    correlationId: error.correlationId,
    retryAfterSeconds: error.retryAfterSeconds
  });

  const envelope = normalizeErrorEnvelopeFromHttpError(error);
  bookingError.code = envelope.error.code;
  bookingError.envelope = envelope;

  return bookingError;
};

export const confirmBooking = async (
  payload: ConfirmBookingPayload,
  options: ConfirmBookingOptions
): Promise<ConfirmBookingResult> => {
  const baseUrl = resolveBookingBaseUrl(options.baseUrl);
  const correlationId = options.correlationId ?? createCorrelationId();
  const requestId = createCorrelationId();

  try {
    const { data, response } = await postJson<unknown>('booking/confirm', {
      baseUrl,
      body: payload,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      correlationId,
      requestId,
      headers: {
        'Idempotency-Key': options.idempotencyKey
      },
      retry: { maxRetries: 1, baseDelayMs: 300, jitter: true }
    });

    const normalized = normalizeConfirmResponse(data);
    if (!normalized) {
      throw new Error('Invalid confirmation response payload.');
    }

    const responseCorrelation = response.headers.get('x-correlation-id') ?? correlationId;
    return {
      ...normalized,
      correlationId: responseCorrelation ?? correlationId
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw normalizeBookingApiError(error);
    }
    throw error;
  }
};
