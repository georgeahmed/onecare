import type { ClinicianTaskDetail, ClinicianTaskSummary } from '@onecare/events';
import {
  QueueGatewayError,
  type QueueAuthContext,
  type QueueFilters,
  type QueueGateway,
  type RecommendedWindow
} from './queue.types';

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_RETRIES = 2;

const makeCorrelationId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HttpQueueGatewayOptions {
  queueBaseUrl: string;
  bookingBaseUrl?: string;
  timeoutMs?: number;
  authProvider?: () => QueueAuthContext;
}

export class HttpQueueGateway implements QueueGateway {
  private readonly queueBaseUrl: string;
  private readonly bookingBaseUrl?: string;
  private readonly timeoutMs: number;
  private readonly authProvider?: () => QueueAuthContext;
  private authOverride: QueueAuthContext = {};

  constructor(options: HttpQueueGatewayOptions) {
    this.queueBaseUrl = options.queueBaseUrl.replace(/\/$/, '');
    this.bookingBaseUrl = options.bookingBaseUrl?.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authProvider = options.authProvider;
  }

  setAuthContext(context: QueueAuthContext): void {
    this.authOverride = context;
  }

  private auth(): QueueAuthContext {
    return { ...(this.authProvider?.() ?? {}), ...this.authOverride };
  }

  private headers(correlationId: string): Record<string, string> {
    const auth = this.auth();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-correlation-id': correlationId
    };
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    if (auth.userId) {
      headers['x-actor-id'] = auth.userId;
      headers['x-actor-type'] = 'practitioner';
    }
    if (auth.clinicId) headers['x-clinic-id'] = auth.clinicId;
    return headers;
  }

  private async fetchJson<T>(url: string, init: RequestInit, correlationId: string): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= MAX_RETRIES) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        const res = await fetch(url, { ...init, signal: controller?.signal });
        if (res.ok) {
          const contentType = res.headers.get('content-type') ?? '';
          if (contentType.includes('application/json')) {
            return (await res.json()) as T;
          }
          return {} as T;
        }

        if (res.status === 404) {
          throw new QueueGatewayError('not_found', 'Not found', correlationId);
        }
        const retryable = res.status >= 500 || res.status === 429;
        const message = await res.text().catch(() => '');
        if (!retryable || attempt === MAX_RETRIES) {
          throw new QueueGatewayError('network', message || `status_${res.status}`, correlationId);
        }
      } catch (error) {
        lastError = error;
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        if (!isAbort && attempt === MAX_RETRIES) {
          throw new QueueGatewayError('network', error instanceof Error ? error.message : 'Network error', correlationId);
        }
        if (isAbort && attempt === MAX_RETRIES) {
          throw new QueueGatewayError('network', 'Request timed out', correlationId);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      attempt += 1;
      await sleep(150 + Math.random() * 120);
    }
    throw new QueueGatewayError('network', lastError instanceof Error ? lastError.message : 'Network error', correlationId);
  }

  private requireQueueBase(correlationId: string): string {
    if (!this.queueBaseUrl) {
      throw new QueueGatewayError('network', 'Queue API is not configured', correlationId);
    }
    return this.queueBaseUrl;
  }

  private requireBookingBase(correlationId: string): string {
    if (!this.bookingBaseUrl) {
      throw new QueueGatewayError('network', 'Booking API is not configured', correlationId);
    }
    return this.bookingBaseUrl;
  }

  async list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string }> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = new URL(`${base}/clinician/tasks`);
    url.searchParams.set('clinicId', filters.clinicId);
    if (filters.priority) url.searchParams.set('priority', filters.priority);
    if (filters.status) url.searchParams.set('status', filters.status);
    if (filters.assignee) url.searchParams.set('assignee', filters.assignee);
    if (filters.limit) url.searchParams.set('limit', String(filters.limit));
    if (filters.from) url.searchParams.set('from', filters.from);
    if (filters.to) url.searchParams.set('to', filters.to);
    if (filters.cursor) url.searchParams.set('cursor', filters.cursor);
    return this.fetchJson<{ items: ClinicianTaskSummary[]; nextCursor?: string }>(
      url.toString(),
      { method: 'GET', headers: this.headers(correlationId) },
      correlationId
    );
  }

  async getById(id: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      { method: 'GET', headers: this.headers(correlationId) },
      correlationId
    );
  }

  async assign(id: string, assignee?: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/assign`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify({ assignee })
      },
      correlationId
    );
  }

  async unassign(id: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/unassign`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      { method: 'POST', headers: this.headers(correlationId) },
      correlationId
    );
  }

  async resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/resolve`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify({ outcome, note })
      },
      correlationId
    );
  }

  async scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/schedule-callback`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify({ when: whenIso, note })
      },
      correlationId
    );
  }

  async bookSlot(id: string, slotId: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    if (!slotId) {
      throw new QueueGatewayError('network', 'Slot id is required for booking', correlationId);
    }
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/book-slot`;
    return this.fetchJson<ClinicianTaskDetail>(
      url,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify({ slotId })
      },
      correlationId
    );
  }

  async assistedOutcome(
    id: string,
    outcome: 'booked' | 'no_time' | 'pharmacy_referral_sent',
    options?: { start?: string; end?: string; location?: string; serviceType?: string; notes?: string; patientId?: string },
  ): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const bookingBase = this.requireBookingBase(correlationId);
    const auth = this.auth();
    const recordedBy = auth.userId?.trim() || 'clinician-dev';

    const body: Record<string, unknown> = {
      taskId: id.startsWith('Task/') ? id : `Task/${id}`,
      patientId: normalizePatientId(options?.patientId, correlationId),
      outcome,
      recordedAt: new Date().toISOString(),
      recordedBy,
      notes: options?.notes,
    };
    if (outcome === 'booked') {
      const start = options?.start ?? new Date().toISOString();
      const end = options?.end ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
      body.slot = {
        start,
        end,
        location: options?.location ?? auth.clinicId ?? 'org-dev',
        serviceType: options?.serviceType ?? 'GP',
      };
    }

    await this.fetchJson<void>(
      `${bookingBase}/booking/assisted`,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify(body),
      },
      correlationId
    );

    // Refresh latest detail so UI matches booking result.
    return this.getById(id);
  }

  async recordCall(id: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/call`;
    try {
      return await this.fetchJson<ClinicianTaskDetail>(
        url,
        { method: 'POST', headers: this.headers(correlationId) },
        correlationId
      );
    } catch (error) {
      if (error instanceof QueueGatewayError && error.code === 'not_found') {
        return this.getById(id);
      }
      throw error;
    }
  }

  async escalate(id: string): Promise<ClinicianTaskDetail> {
    const correlationId = makeCorrelationId();
    const base = this.requireQueueBase(correlationId);
    const url = `${base}/clinician/tasks/${encodeURIComponent(id)}/escalate`;
    try {
      return await this.fetchJson<ClinicianTaskDetail>(
        url,
        { method: 'POST', headers: this.headers(correlationId) },
        correlationId
      );
    } catch (error) {
      if (error instanceof QueueGatewayError && error.code === 'not_found') {
        return this.getById(id);
      }
      throw error;
    }
  }

  async recommendWindows(
    _id: string,
    options?: { windowStart?: string; windowEnd?: string; location?: string; serviceType?: string },
  ): Promise<RecommendedWindow[]> {
    const correlationId = makeCorrelationId();
    const bookingBase = this.requireBookingBase(correlationId);
    const auth = this.auth();
    const windowStart = options?.windowStart ?? new Date().toISOString();
    const windowEnd = options?.windowEnd ?? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const location = options?.location ?? auth.clinicId ?? 'org-dev';
    const serviceType = options?.serviceType ?? 'GP';

    const body = await this.fetchJson<{ slots?: Array<{ start: string; end: string; organisationId?: string; serviceType?: string }> }>(
      `${bookingBase}/booking/search`,
      {
        method: 'POST',
        headers: this.headers(correlationId),
        body: JSON.stringify({ serviceType, windowStart, windowEnd, location }),
      },
      correlationId
    );

    const slots = Array.isArray(body.slots) ? body.slots.slice(0, 5) : [];
    return slots.map((slot) => ({
      start: slot.start,
      end: slot.end,
      location: slot.organisationId ?? location,
      serviceType: slot.serviceType ?? serviceType,
    }));
  }
}

function normalizePatientId(value: string | undefined, correlationId: string): string {
  if (!value || value.trim().length === 0) {
    throw new QueueGatewayError('network', 'Patient id is required for assisted booking', correlationId);
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('Patient/')) return trimmed;
  return `Patient/${trimmed}`;
}
