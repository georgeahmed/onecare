import type { ClinicianTaskSummary, ClinicianTaskDetail } from '@onecare/events';
import { QueueGatewayError, type QueueFilters, type QueueGateway, type RecommendedWindow } from './queue.types';

const now = Date.now();

const defaultSeed: ClinicianTaskDetail[] = [
  {
    id: 't-001',
    clinicId: 'demo',
    priority: 'STAT',
    status: 'NEW',
    shortReason: 'Chest pain',
    patientId: 'p-1001',
    waitMs: 12 * 60 * 1000,
    interpreter: 'ur',
    createdAt: new Date(now - 15 * 60 * 1000).toISOString(),
    narrative: 'Severe chest pain started this morning. Shortness of breath.',
    attachments: [],
    actionsAllowed: ['CALL', 'ESCALATE', 'RESOLVE'],
    audit: [],
    correlationId: 'corr-stat-001'
  },
  {
    id: 't-002',
    clinicId: 'demo',
    priority: 'URGENT',
    status: 'NEW',
    shortReason: 'High fever',
    patientId: 'p-1002',
    waitMs: 42 * 60 * 1000,
    createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
    narrative: 'Fever at 39.5°C, headache since last night.',
    attachments: [],
    actionsAllowed: ['CALL', 'SCHEDULE', 'BOOK', 'RESOLVE'],
    audit: [],
    correlationId: 'corr-urg-002'
  },
  {
    id: 't-003',
    clinicId: 'demo',
    priority: 'ROUTINE',
    status: 'NEW',
    shortReason: 'Medication query',
    patientId: 'p-1003',
    waitMs: 2 * 60 * 60 * 1000,
    createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    narrative: 'Question about dosage for prescribed medication.',
    attachments: [],
    actionsAllowed: ['CALL', 'SCHEDULE', 'BOOK', 'RESOLVE'],
    audit: [],
    correlationId: 'corr-rt-003'
  },
  {
    id: 't-004',
    clinicId: 'north',
    priority: 'URGENT',
    status: 'IN_PROGRESS',
    shortReason: 'Respiratory distress follow-up',
    patientId: 'p-2101',
    waitMs: 65 * 60 * 1000,
    createdAt: new Date(now - 65 * 60 * 1000).toISOString(),
    narrative: 'Recent discharge, breathing concerns reported by caregiver.',
    attachments: [],
    actionsAllowed: ['CALL', 'ESCALATE', 'RESOLVE'],
    audit: [
      { when: new Date(now - 30 * 60 * 1000).toISOString(), who: 'coordinator-1', what: 'assign' }
    ],
    assignee: 'coordinator-1',
    correlationId: 'corr-urg-004'
  },
  {
    id: 't-005',
    clinicId: 'north',
    priority: 'SOON',
    status: 'NEW',
    shortReason: 'Medication refill',
    patientId: 'p-2102',
    waitMs: 20 * 60 * 1000,
    createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
    narrative: 'Refill needed before weekend travel.',
    attachments: [],
    actionsAllowed: ['CALL', 'SCHEDULE', 'BOOK', 'RESOLVE'],
    audit: [],
    correlationId: 'corr-soon-005'
  }
];

function summaryOf(detail: ClinicianTaskDetail): ClinicianTaskSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { narrative: _n, attachments: _a, actionsAllowed: _aa, audit: _ad, correlationId: _c, ...rest } = detail;
  return rest as unknown as ClinicianTaskSummary;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelay = async () => {
  const min = 160;
  const max = 420;
  await wait(min + Math.random() * (max - min));
};

const matchesTimeWindow = (detail: ClinicianTaskDetail, filters: QueueFilters): boolean => {
  if (!filters.from && !filters.to) return true;
  const created = new Date(detail.createdAt).getTime();
  if (filters.from && created < new Date(filters.from).getTime()) return false;
  if (filters.to && created > new Date(filters.to).getTime()) return false;
  return true;
};

export class MockQueueGateway implements QueueGateway {
  private readonly tasks: ClinicianTaskDetail[];
  private currentUserId: string;

  constructor(userId = 'clinician-dev', seed: ClinicianTaskDetail[] = defaultSeed) {
    this.currentUserId = userId;
    this.tasks = structuredClone(seed);
  }

  setAuthContext(context: { userId?: string; clinicId?: string }): void {
    this.currentUserId = context.userId?.trim() || 'clinician-dev';
  }

  async list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string }> {
    await randomDelay();
    const items = this.tasks
      .filter((d) => d.clinicId === filters.clinicId)
      .filter((d) => (filters.priority ? d.priority === filters.priority : true))
      .filter((d) => (filters.status ? d.status === filters.status : true))
      .filter((d) => {
        if (!filters.assignee || filters.assignee === 'any') return true;
        if (filters.assignee === 'unassigned') {
          return !('assignee' in d) || !d.assignee;
        }
        if (filters.assignee === 'me') {
          return ('assignee' in d && d.assignee === this.currentUserId) === true;
        }
        return true;
      })
      .filter((d) => matchesTimeWindow(d, filters))
      .slice(0, filters.limit ?? 50)
      .map((detail) => summaryOf(detail));
    return { items: structuredClone(items) };
  }

  async getById(id: string): Promise<ClinicianTaskDetail> {
    await randomDelay();
    const found = this.tasks.find((d) => d.id === id);
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    return structuredClone(found);
  }

  async assign(id: string, assignee?: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    if (found.assignee && found.assignee !== this.currentUserId) {
      throw new QueueGatewayError('conflict', 'Task already assigned', found.correlationId);
    }
    (found as any).assignee = assignee ?? this.currentUserId;
    (found as any).status = 'IN_PROGRESS';
    found.audit.push({ when: new Date().toISOString(), who: this.currentUserId, what: 'assign' });
    return structuredClone(found);
  }

  async unassign(id: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    if (!found.assignee) {
      throw new QueueGatewayError('conflict', 'Task already unassigned', found.correlationId);
    }
    delete (found as any).assignee;
    (found as any).status = 'NEW';
    found.audit.push({ when: new Date().toISOString(), who: this.currentUserId, what: 'unassign' });
    return structuredClone(found);
  }

  async resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    (found as any).status = 'DONE';
    (found as any).actionsAllowed = [];
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `resolve:${outcome}${note ? ':' + note : ''}` });
    return structuredClone(found);
  }

  async scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `schedule:${whenIso}${note ? ':' + note : ''}` });
    (found as any).status = 'IN_PROGRESS';
    return structuredClone(found);
  }

  async bookSlot(id: string, slotId: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `book:${slotId}` });
    (found as any).status = 'DONE';
    (found as any).actionsAllowed = [];
    return structuredClone(found);
  }

  async assistedOutcome(
    id: string,
    outcome: 'booked' | 'no_time' | 'pharmacy_referral_sent',
    options?: { start?: string; end?: string; location?: string; serviceType?: string; notes?: string; patientId?: string },
  ): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    const stamp = new Date().toISOString();
    const note = options?.notes ? `:${options.notes}` : '';
    const slotPart = options?.start && options?.end ? `:${options.start}->${options.end}` : '';
    (found as any).audit.push({ when: stamp, who: this.currentUserId, what: `assisted:${outcome}${slotPart}${note}` });
    if (outcome === 'booked' || outcome === 'pharmacy_referral_sent') {
      (found as any).status = 'DONE';
      (found as any).actionsAllowed = [];
    } else {
      (found as any).status = 'IN_PROGRESS';
    }
    return structuredClone(found);
  }

  async recordCall(id: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    found.audit.push({ when: new Date().toISOString(), who: this.currentUserId, what: 'call:initiated' });
    return structuredClone(found);
  }

  async escalate(id: string): Promise<ClinicianTaskDetail> {
    const found = this.tasks.find((d) => d.id === id);
    await randomDelay();
    if (!found) throw new QueueGatewayError('not_found', 'Task not found', 'mock');
    found.audit.push({ when: new Date().toISOString(), who: this.currentUserId, what: 'escalate:manual' });
    (found as any).status = 'IN_PROGRESS';
    return structuredClone(found);
  }

  async recommendWindows(_id: string): Promise<RecommendedWindow[]> {
    const base = Date.now() + 60 * 60 * 1000; // start an hour from now
    const fifteen = 15 * 60 * 1000;
    const mk = (offsetMin: number) => {
      const start = new Date(base + offsetMin * 60 * 1000);
      const end = new Date(start.getTime() + fifteen);
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        location: 'org-dev',
        serviceType: 'GP',
      } as RecommendedWindow;
    };
    return [mk(0), mk(30), mk(60), mk(120), mk(240)];
  }
}
