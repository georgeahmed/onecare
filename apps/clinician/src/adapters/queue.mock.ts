import type { ClinicianTaskSummary, ClinicianTaskDetail } from '@onecare/events';
import type { QueueFilters, QueueGateway } from './queue.types';

const now = Date.now();

const seeded: ClinicianTaskDetail[] = [
  {
    id: 't-001',
    clinicId: 'demo',
    priority: 'STAT',
    status: 'NEW',
    shortReason: 'Chest pain',
    patientId: 'p-1001',
    waitMs: 15 * 60 * 1000,
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
    waitMs: 40 * 60 * 1000,
    createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
    narrative: 'Fever at 39.5°C, headache since last night.',
    attachments: [],
    actionsAllowed: ['CALL', 'SCHEDULE', 'RESOLVE'],
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
    actionsAllowed: ['CALL', 'SCHEDULE', 'RESOLVE'],
    audit: [],
    correlationId: 'corr-rt-003'
  }
];

function summaryOf(detail: ClinicianTaskDetail): ClinicianTaskSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { narrative: _n, attachments: _a, actionsAllowed: _aa, audit: _ad, correlationId: _c, ...rest } = detail;
  return rest as unknown as ClinicianTaskSummary;
}

export class MockQueueGateway implements QueueGateway {
  async list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string }> {
    const items = seeded
      .filter((d) => d.clinicId === filters.clinicId)
      .filter((d) => (filters.priority ? d.priority === filters.priority : true))
      .filter((d) => (filters.status ? d.status === filters.status : true))
      .slice(0, filters.limit ?? 50)
      .map(summaryOf);
    return { items };
  }

  async getById(id: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    return structuredClone(found);
  }

  async assign(id: string, assignee?: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    (found as any).assignee = assignee ?? 'me';
    (found as any).status = 'IN_PROGRESS';
    return structuredClone(found);
  }

  async unassign(id: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    delete (found as any).assignee;
    (found as any).status = 'NEW';
    return structuredClone(found);
  }

  async resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    (found as any).status = 'DONE';
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `resolve:${outcome}${note ? ':' + note : ''}` });
    return structuredClone(found);
  }

  async scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `schedule:${whenIso}${note ? ':' + note : ''}` });
    (found as any).status = 'IN_PROGRESS';
    return structuredClone(found);
  }

  async bookSlot(id: string, slotId: string): Promise<ClinicianTaskDetail> {
    const found = seeded.find((d) => d.id === id);
    if (!found) throw new Error('not_found');
    (found as any).audit.push({ when: new Date().toISOString(), who: 'me', what: `book:${slotId}` });
    (found as any).status = 'DONE';
    (found as any).actionsAllowed = [];
    return structuredClone(found);
  }
}
