import { MockQueueGateway } from './queue.mock';
import type { QueueFilters, QueueGateway, RecommendedWindow } from './queue.types';
import type { ClinicianTaskDetail, ClinicianTaskSummary } from '@onecare/events';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AssistedGatewayOptions {
  bookingBaseUrl: string;
  correlationId?: string;
  recordedBy?: string;
}

/**
 * Assisted booking gateway that delegates all queue operations to a local mock,
 * but sends assisted booking outcomes to the Booking service when configured.
 */
export class HttpAssistedBookingGateway implements QueueGateway {
  private readonly delegate: MockQueueGateway;
  private readonly baseUrl: string;
  private readonly recordedBy: string;
  private readonly correlationId: string;

  constructor(options: AssistedGatewayOptions, delegate = new MockQueueGateway()) {
    this.baseUrl = options.bookingBaseUrl.replace(/\/$/, '');
    this.delegate = delegate;
    this.recordedBy = options.recordedBy?.trim() || 'clinician-dev';
    this.correlationId = options.correlationId?.trim() || uuid();
  }

  async list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string | undefined }> {
    return this.delegate.list(filters);
  }

  async getById(id: string): Promise<ClinicianTaskDetail> {
    return this.delegate.getById(id);
  }

  async assign(id: string, assignee?: string): Promise<ClinicianTaskDetail> {
    return this.delegate.assign(id, assignee);
  }

  async unassign(id: string): Promise<ClinicianTaskDetail> {
    return this.delegate.unassign(id);
  }

  async resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail> {
    return this.delegate.resolve(id, outcome, note);
  }

  async scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail> {
    return this.delegate.scheduleCallback(id, whenIso, note);
  }

  async recordCall(id: string): Promise<ClinicianTaskDetail> {
    return this.delegate.recordCall(id);
  }

  async escalate(id: string): Promise<ClinicianTaskDetail> {
    return this.delegate.escalate(id);
  }

  /**
   * Sends an assisted booking outcome to the Booking service, then mirrors the change into the local mock
   * so the UI reflects completion immediately.
   */
  async bookSlot(id: string, _slotId: string): Promise<ClinicianTaskDetail> {
    // Deprecated prompt flow replaced by assisted outcome; keep a noop quick-book for compatibility
    const startIso = new Date().toISOString();
    const endIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await this.assistedOutcome(id, 'booked', {
      start: startIso,
      end: endIso,
      location: 'org-dev',
      serviceType: 'GP',
      notes: 'Quick booked via legacy action',
    });
    return this.delegate.getById(id);
  }

  async assistedOutcome(
    id: string,
    outcome: 'booked' | 'no_time' | 'pharmacy_referral_sent',
    options?: { start?: string; end?: string; location?: string; serviceType?: string; notes?: string; patientId?: string },
  ): Promise<ClinicianTaskDetail> {
    const body: Record<string, unknown> = {
      taskId: id.startsWith('Task/') ? id : `Task/${id}`,
      patientId: normalizePatientId(options?.patientId),
      outcome,
      recordedAt: new Date().toISOString(),
      recordedBy: this.recordedBy,
      notes: options?.notes,
    };
    if (outcome === 'booked') {
      const start = options?.start ?? new Date().toISOString();
      const end = options?.end ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
      body.slot = {
        start,
        end,
        location: options?.location ?? 'org-dev',
        serviceType: options?.serviceType ?? 'GP',
      };
    }

    await fetch(`${this.baseUrl}/booking/assisted`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': this.correlationId,
      },
      body: JSON.stringify(body),
    }).catch(() => {
      // tolerate network issues in dev; UI mirrors via mock below
    });

    return this.delegate.assistedOutcome(id, outcome, options);
  }

  async recommendWindows(
    id: string,
    options?: { windowStart?: string; windowEnd?: string; location?: string; serviceType?: string },
  ): Promise<RecommendedWindow[]> {
    const windowStart = options?.windowStart ?? new Date().toISOString();
    const windowEnd = options?.windowEnd ?? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const location = options?.location ?? 'org-dev';
    const serviceType = options?.serviceType ?? 'GP';
    try {
      const res = await fetch(`${this.baseUrl}/booking/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': this.correlationId,
        },
        body: JSON.stringify({ serviceType, windowStart, windowEnd, location }),
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      const body = (await res.json()) as { slots?: Array<{ start: string; end: string; organisationId?: string; serviceType?: string }> };
      const slots = Array.isArray(body.slots) ? body.slots.slice(0, 5) : [];
      return slots.map((slot) => ({
        start: slot.start,
        end: slot.end,
        location: slot.organisationId,
        serviceType: slot.serviceType,
      }));
    } catch {
      return this.delegate.recommendWindows(id);
    }
  }
}

function normalizePatientId(value?: string): string {
  if (!value || value.trim().length === 0) return 'Patient/dev';
  const trimmed = value.trim();
  if (trimmed.startsWith('Patient/')) return trimmed;
  return `Patient/${trimmed}`;
}
