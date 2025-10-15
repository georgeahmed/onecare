import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createHistogram, createCounter, startSpan, getCorrelationId, logger } from '@onecare/observability';
import { SpanStatusCode } from '@opentelemetry/api';
import { callWithGuard, type GuardOptions } from './callWithGuard';

export interface GpConnectClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  appointmentExecutor?: AppointmentExecutor;
  practiceId?: string;
  authHeaders?: Record<string, string>;
}

export interface SearchSlotsParams {
  organisationId: string;
  serviceType?: string;
  startDate?: string;
  endDate?: string;
}

export interface Slot {
  slotId: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
}

export interface AppointmentRequest {
  slotId: string;
  patientId: string;
  reason: string;
  performerId?: string;
}

export interface AppointmentRef {
  appointmentId: string;
  slotId: string;
  start: string;
  end: string;
}

export interface SlotView {
  id: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
}

export type AppointmentExecutor = (request: AppointmentRequest) => Promise<AppointmentRef>;

export type GpConnectErrorCode = 'conflict' | 'unavailable' | 'unknown';

export class GpConnectClientError extends Error {
  constructor(public readonly code: GpConnectErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GpConnectClientError';
  }
}

const searchLatencyHistogram = createHistogram('gp_connect_search_latency_ms');
const createLatencyHistogram = createHistogram('gp_connect_create_latency_ms');
const searchSuccessCounter = createCounter('gp_connect_search_success_total');
const searchErrorCounter = createCounter('gp_connect_search_error_total');
const createSuccessCounter = createCounter('gp_connect_create_success_total');
const createErrorCounter = createCounter('gp_connect_create_error_total');
const createConflictCounter = createCounter('gp_connect_create_conflict_total');

export interface GpConnectClient {
  searchSlots(params: SearchSlotsParams): Promise<Slot[]>;
  createAppointment(request: AppointmentRequest): Promise<AppointmentRef>;
}

export class GpConnectHttpClient implements GpConnectClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly appointmentExecutor?: AppointmentExecutor;
  private readonly practiceId?: string;
  private readonly authHeaders: Record<string, string>;

  constructor(options: GpConnectClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.appointmentExecutor = options.appointmentExecutor;
    this.practiceId = options.practiceId;
    this.authHeaders = buildAuthHeaders(options.apiKey, options.authHeaders);
  }

  private guardOptions(operation: 'search' | 'create'): GuardOptions {
    const baseDelay = Math.max(50, Math.floor(this.timeoutMs * 0.1));
    return {
      timeoutMs: this.timeoutMs,
      baseDelayMs: baseDelay,
      maxRetries: operation === 'search' ? 1 : 0,
      correlationId: getCorrelationId(),
    };
  }

  private async guardCall<T>(operation: 'search' | 'create', handler: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return callWithGuard(`gpconnect.${operation}`, handler, this.guardOptions(operation));
  }

  static fromEnv(): GpConnectHttpClient {
    const baseUrl = process.env.GP_CONNECT_URL?.trim();
    const apiKey = process.env.GP_CONNECT_API_KEY?.trim();
    if (!baseUrl) throw new Error('gp_connect_url_missing');
    if (!apiKey) throw new Error('gp_connect_api_key_missing');
    const timeoutMs = Number(process.env.GP_CONNECT_TIMEOUT_MS ?? '5000');
    const headerName = process.env.GP_CONNECT_AUTH_HEADER_NAME?.trim();
    const headerValue = process.env.GP_CONNECT_AUTH_HEADER_VALUE?.trim();
    const authHeaders =
      headerName && headerValue ? { [headerName]: headerValue } : undefined;
    const practiceId = process.env.GP_CONNECT_PRACTICE_ID?.trim();
    return new GpConnectHttpClient({
      baseUrl,
      apiKey,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5_000,
      authHeaders,
      practiceId: practiceId || undefined,
    });
  }

  async searchSlots(params: SearchSlotsParams): Promise<Slot[]> {
    const attributes = buildMetricAttributes('search', this.practiceId, params.organisationId);
    const span = startSpan('gpconnect.search', {
      attributes: {
        'gpconnect.operation': 'search_slots',
        'gpconnect.base_url': this.baseUrl,
        'gpconnect.organisation_id': params.organisationId ?? 'unknown',
        'gpconnect.practice_id': this.practiceId ?? 'unknown',
      },
    });
    const start = performance.now();
    try {
      const result = await this.guardCall('search', async (signal) => {
        await delay(5, undefined, { signal });
        const slots: Slot[] = [
          {
            slotId: 'demo-slot-1',
            start: new Date().toISOString(),
            end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
            organisationId: params.organisationId,
            serviceType: params.serviceType,
          },
        ];
        return slots;
      });
      recordLatency(searchLatencyHistogram, start, attributes);
      searchSuccessCounter.add(1, attributes);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      logger.info('gpconnect.search.success', {
        durationMs: performance.now() - start,
        organisationId: params.organisationId,
        practiceId: this.practiceId,
        correlationId: getCorrelationId(),
      });
      return result;
    } catch (error) {
      recordLatency(searchLatencyHistogram, start, attributes);
      searchErrorCounter.add(1, attributes);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      span.end();
      logger.error('gpconnect.search.error', {
        reason: (error as Error).message,
        organisationId: params.organisationId,
        practiceId: this.practiceId,
        correlationId: getCorrelationId(),
      });
      throw error;
    }
  }

  async createAppointment(request: AppointmentRequest): Promise<AppointmentRef> {
    const executor = this.appointmentExecutor ?? defaultAppointmentExecutor;
    let attempt = 0;
    let lastError: unknown;
    const attributes = buildMetricAttributes('create', this.practiceId, request.performerId ?? request.slotId);

    while (attempt < 2) {
      const span = startSpan('gpconnect.create_appointment', {
        attributes: {
          'gpconnect.operation': 'create_appointment',
          'gpconnect.base_url': this.baseUrl,
          'gpconnect.slot_id': request.slotId,
          'gpconnect.practice_id': this.practiceId ?? 'unknown',
        },
      });
      const start = performance.now();
      try {
        const response = await this.guardCall('create', async () => executor(request));
        recordLatency(createLatencyHistogram, start, attributes);
        createSuccessCounter.add(1, attributes);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        logger.info('gpconnect.create.success', {
          slotId: request.slotId,
          appointmentId: response.appointmentId,
          practiceId: this.practiceId,
          correlationId: getCorrelationId(),
          durationMs: performance.now() - start,
        });
        return response;
      } catch (error) {
        lastError = error;
        const conflict = isConflictError(error);
        recordLatency(createLatencyHistogram, start, attributes);
        if (conflict) {
          createConflictCounter.add(1, attributes);
          logger.warn('gpconnect.create.conflict', {
            slotId: request.slotId,
            attempt,
            practiceId: this.practiceId,
            correlationId: getCorrelationId(),
          });
        } else {
          createErrorCounter.add(1, attributes);
          logger.error('gpconnect.create.error', {
            slotId: request.slotId,
            reason: (error as Error).message,
            practiceId: this.practiceId,
            correlationId: getCorrelationId(),
          });
        }

        if (conflict && attempt === 0) {
          const backoffMs = Math.min(200, Math.max(50, this.timeoutMs * 0.05));
          await delay(backoffMs + Math.random() * 25);
          attempt += 1;
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          span.end();
          continue;
        }
        const mapped = mapToClientError(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.message });
        span.end();
        throw mapped;
      }
    }

    throw mapToClientError(lastError);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getAuthHeaders(): Record<string, string> {
    return { ...this.authHeaders };
  }
}

export function mapSlotsToView(slots: Slot[]): SlotView[] {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  return slots.map((slot) => ({
    id: slot.slotId,
    start: slot.start,
    end: slot.end,
    organisationId: slot.organisationId,
    serviceType: slot.serviceType,
  }));
}

function buildAuthHeaders(apiKey: string, overrides?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Ssp-Api-Key'] = apiKey;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value) headers[key] = value;
    }
  }
  return headers;
}

async function defaultAppointmentExecutor(request: AppointmentRequest): Promise<AppointmentRef> {
  await delay(5);
  return {
    appointmentId: `appt-${request.slotId}`,
    slotId: request.slotId,
    start: new Date().toISOString(),
    end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
}

function isConflictError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const status = (error as { status?: number }).status;
    if (status === 409) return true;
    const code = (error as { code?: string }).code;
    if (code?.toLowerCase() === 'conflict') return true;
  }
  if (typeof error === 'string') {
    return error.toLowerCase().includes('conflict');
  }
  return false;
}

function mapToClientError(error: unknown): GpConnectClientError {
  if (isConflictError(error)) {
    return new GpConnectClientError('conflict', 'Appointment slot already booked', error);
  }
  if (typeof error === 'object' && error) {
    const status = (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status;
    if (status && status >= 500) {
      return new GpConnectClientError('unavailable', 'GP Connect service unavailable', error);
    }
  }
  return new GpConnectClientError('unknown', 'GP Connect request failed', error);
}

function recordLatency(histogram: ReturnType<typeof createHistogram>, start: number, attributes: Record<string, unknown>): void {
  histogram.record(performance.now() - start, attributes);
}

function buildMetricAttributes(operation: 'search' | 'create', practiceId?: string, identifier?: string): Record<string, unknown> {
  return {
    operation,
    practiceId: practiceId ?? 'unknown',
    target: identifier ?? 'unknown',
  };
}
