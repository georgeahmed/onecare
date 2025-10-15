import { v4 as uuidv4 } from 'uuid';
import type { BookingModality, BookingQueryFilters, BookingSlot } from './booking';
import type { ErrorEnvelope, PortalSubmission, SafetyDecision } from './types';
import type { ErrorObject } from '@onecare/events/src/contracts/error-envelope';

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
const DEFAULT_RETRY = {
  maxRetries: 2,
  baseDelayMs: 250,
  jitter: true
};

const KNOWN_ERROR_CODES: readonly ErrorObject['code'][] = [
  'unauthorized',
  'forbidden',
  'invalid_input',
  'unsupported_media_type',
  'payload_too_large',
  'conflict',
  'upstream_timeout',
  'upstream_unavailable',
  'internal_error',
  'too_many_requests',
  'busy',
  'invalid_fhir',
] as const;

const isKnownErrorCode = (code: string): code is ErrorObject['code'] =>
  (KNOWN_ERROR_CODES as readonly string[]).includes(code);

export interface SubmitIntakeResult {
  decision: SafetyDecision;
  correlationId?: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetry = (status: number): boolean => status === 429 || status === 503;

const computeDelay = (attempt: number, baseDelay: number, jitter: boolean): number => {
  const expDelay = baseDelay * Math.pow(2, attempt);
  if (!jitter) return expDelay;
  const randomFactor = Math.random() + 0.5; // between 0.5 and 1.5
  return expDelay * randomFactor;
};

export const submitIntake = async (
  payload: PortalSubmission,
  options: SubmitIntakeOptions = {}
): Promise<SubmitIntakeResult> => {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('safety-check', normalizedBaseUrl).toString();
  const retryConfig = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  const initialCorrelationId = uuidv4();
  const requestId = uuidv4();
  let lastResponseCorrelationId: string | undefined;

  const maxRetries = retryConfig.maxRetries ?? 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    let abortedByTimeout = false;
    let abortedByExternal = false;
    const timeout = setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const externalSignal = options.signal;
    let externalAbortHandler: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortedByExternal = true;
        controller.abort();
      } else {
        externalAbortHandler = () => {
          abortedByExternal = true;
          controller.abort();
        };
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    const requestCorrelationId = initialCorrelationId;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-correlation-id': requestCorrelationId,
      'x-request-id': requestId
    };
    if (options.locale) {
      headers['accept-language'] = options.locale;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'include'
      });
      const responseCorrelation = response.headers.get('x-correlation-id') ?? requestCorrelationId;
      lastResponseCorrelationId = responseCorrelation;

      if (response.ok) {
        const decision = (await response.json()) as SafetyDecision;
        return {
          decision,
          correlationId: responseCorrelation ?? undefined
        };
      }

      if (shouldRetry(response.status) && attempt < maxRetries) {
        const nextAttempt = attempt + 1;
        options.onRetry?.({ attempt: nextAttempt, maxRetries, correlationId: responseCorrelation });
        const delay = computeDelay(attempt, retryConfig.baseDelayMs ?? 250, retryConfig.jitter ?? true);
        await wait(delay);
        continue;
      }

      let envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
      if (!envelope || typeof envelope !== 'object' || !('error' in envelope)) {
        envelope = {
          error: {
            code: 'internal_error',
            message: `Request failed with status ${response.status}`,
          },
        };
      }
      if (!envelope.error.correlationId && responseCorrelation) {
        envelope = {
          error: {
            ...envelope.error,
            correlationId: responseCorrelation,
          },
        };
      }
      throw Object.assign(new Error('Request failed'), {
        response,
        envelope
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        if (abortedByExternal && !abortedByTimeout) {
          const cancelError = new Error('Request cancelled');
          Object.assign(cancelError, { __clientCancelled: true });
          throw cancelError;
        }
        lastResponseCorrelationId = lastResponseCorrelationId ?? requestCorrelationId;
        const timeoutEnvelope: ErrorEnvelope = {
          error: {
            code: 'upstream_timeout',
            message: 'The request timed out before completing.',
            correlationId: lastResponseCorrelationId ?? requestCorrelationId,
          },
        };
        const abortError = new Error('Request timed out');
        Object.assign(abortError, { envelope: timeoutEnvelope });
        throw abortError;
      }
      const candidate = error as { response?: Response };
      if (attempt < maxRetries && !candidate?.response) {
        const retryCorrelationId = lastResponseCorrelationId ?? requestCorrelationId;
        lastResponseCorrelationId = retryCorrelationId;
        const nextAttempt = attempt + 1;
        options.onRetry?.({ attempt: nextAttempt, maxRetries, correlationId: retryCorrelationId });
        const delay = computeDelay(attempt, retryConfig.baseDelayMs ?? 250, retryConfig.jitter ?? true);
        await wait(delay);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  throw new Error('Intake submission failed unexpectedly');
};

const DEFAULT_BOOKING_TIMEOUT_MS = 3_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 4_000;

export interface FetchBookingSlotsOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
}

export const fetchBookingSlots = async (
  filters: BookingQueryFilters = {},
  options: FetchBookingSlotsOptions = {}
): Promise<BookingSlot[]> => {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_BOOKING_API_URL ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('booking/slots', normalizedBaseUrl);

  if (filters.modality) {
    url.searchParams.set('modality', filters.modality);
  }
  if (filters.from) {
    url.searchParams.set('from', filters.from);
  }
  if (filters.to) {
    url.searchParams.set('to', filters.to);
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOKING_TIMEOUT_MS;
  let abortedByTimeout = false;
  let externalAbortHandler: (() => void) | undefined;

  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      credentials: 'include',
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new Error(message);
    }

    const payload = await response.json();
    const rawSlots = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { slots?: unknown[] } | undefined)?.slots)
        ? (payload as { slots: unknown[] }).slots
        : [];

    return rawSlots
      .map(normalizeBookingSlot)
      .filter((slot): slot is BookingSlot => slot !== null);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      if (abortedByTimeout) {
        throw new Error('The booking availability request timed out.');
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
};

const normalizeBookingSlot = (value: unknown): BookingSlot | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const start = typeof record.start === 'string' ? record.start : undefined;
  const end = typeof record.end === 'string' ? record.end : undefined;
  const modality = record.modality;

  if (!id || !start || !end) {
    return null;
  }

  if (modality !== 'phone' && modality !== 'in_person') {
    return null;
  }

  const location = typeof record.location === 'string' && record.location.trim().length > 0
    ? record.location.trim()
    : undefined;

  return {
    id,
    start,
    end,
    modality: modality as BookingModality,
    location,
  };
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const data = await response.json();
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message.trim().length > 0) {
        return record.message;
      }
      const errorField = record.error;
      if (errorField && typeof errorField === 'object') {
        const message = (errorField as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
      }
    }
  } catch {
    // ignore JSON parse issues
  }
  return `Failed to load booking slots (status ${response.status})`;
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

const parseRetryAfterSeconds = (headerValue: string | null): number | undefined => {
  if (!headerValue) return undefined;
  const numeric = Number.parseInt(headerValue, 10);
  if (!Number.isNaN(numeric)) {
    return numeric > 0 ? numeric : undefined;
  }
  const retryTarget = Date.parse(headerValue);
  if (Number.isNaN(retryTarget)) return undefined;
  const deltaMs = retryTarget - Date.now();
  if (deltaMs <= 0) return undefined;
  return Math.ceil(deltaMs / 1_000);
};

const parseBookingErrorPayload = async (
  response: Response
): Promise<{ code?: string; message: string; envelope?: ErrorEnvelope }> => {
  let parsedCode: ErrorObject['code'] | undefined;
  let parsedMessage: string | undefined;
  let parsedEnvelope: ErrorEnvelope | undefined;

  try {
    const payload = await response.clone().json();
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const rawError = record.error;
      if (rawError && typeof rawError === 'object') {
        const errorRecord = rawError as Record<string, unknown>;
        const candidateCode = errorRecord.code;
        const candidateMessage = errorRecord.message;
        const candidateDetails = errorRecord.details;
        const candidateCorrelation = errorRecord.correlationId;
        if (typeof candidateCode === 'string' && isKnownErrorCode(candidateCode) && candidateCode.trim().length > 0) {
          parsedCode = candidateCode;
        }
        if (typeof candidateMessage === 'string' && candidateMessage.trim().length > 0) {
          parsedMessage = candidateMessage;
        }
        parsedEnvelope = {
          error: {
            code: parsedCode ?? 'internal_error',
            message: parsedMessage ?? '',
            details: typeof candidateDetails === 'object' && candidateDetails !== null ? (candidateDetails as Record<string, unknown>) : undefined,
            ...(typeof candidateCorrelation === 'string' && candidateCorrelation.trim().length > 0
              ? { correlationId: candidateCorrelation }
              : {}),
          },
        };
      }
    }
  } catch {
    // fall back to generic extractor
  }

  const message = parsedMessage ?? (await extractErrorMessage(response));
  if (parsedEnvelope) {
    parsedEnvelope = {
      error: {
        ...parsedEnvelope.error,
        message,
      },
    };
  }
  return { code: parsedCode, message, envelope: parsedEnvelope };
};

export const confirmBooking = async (
  payload: ConfirmBookingPayload,
  options: ConfirmBookingOptions
): Promise<ConfirmBookingResult> => {
  if (!options.idempotencyKey || options.idempotencyKey.trim().length === 0) {
    throw new Error('idempotency key is required');
  }

  const baseUrl =
    options.baseUrl ?? import.meta.env.VITE_BOOKING_API_URL ?? import.meta.env.VITE_ORCH_URL ?? 'http://localhost:3001';
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('booking/appointments', normalizedBaseUrl).toString();
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const correlationId = options.correlationId ?? uuidv4();
  let externalAbortHandler: (() => void) | undefined;
  let abortedByTimeout = false;

  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': options.idempotencyKey,
        'x-correlation-id': correlationId
      },
      body: JSON.stringify(payload)
    });

    const responseCorrelationId = response.headers.get('x-correlation-id') ?? correlationId;

    if (!response.ok) {
      const { code, message, envelope } = await parseBookingErrorPayload(response);
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      const normalizedEnvelope: ErrorEnvelope | undefined = envelope
        ? ({
            error: {
              ...envelope.error,
              ...(envelope.error.correlationId ? {} : responseCorrelationId ? { correlationId: responseCorrelationId } : {}),
            },
          } as ErrorEnvelope)
        : responseCorrelationId
          ? ({
              error: {
                code: code ?? 'internal_error',
                message,
                correlationId: responseCorrelationId,
              },
            } as ErrorEnvelope)
          : undefined;
      const error: BookingApiError = Object.assign(new Error(message), {
        status: response.status,
        correlationId: responseCorrelationId,
        code,
        retryAfterSeconds,
        envelope: normalizedEnvelope,
      });
      throw error;
    }

    const rawBody = await response.json();
    const normalized = normalizeConfirmResponse(rawBody);
    if (!normalized) {
      const error = new Error('Invalid confirmation response received.');
      Object.assign(error, { correlationId: responseCorrelationId });
      throw error;
    }

    return {
      ...normalized,
      correlationId: responseCorrelationId
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (abortedByTimeout) {
        const timeoutEnvelope: ErrorEnvelope = {
          error: {
            code: 'upstream_timeout',
            message: 'The booking confirmation request timed out.',
            correlationId,
          },
        };
        const timeoutError: BookingApiError = Object.assign(new Error(timeoutEnvelope.error.message), {
          correlationId,
          code: timeoutEnvelope.error.code,
          envelope: timeoutEnvelope,
        });
        throw timeoutError;
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
};
