import type { ClinicianTaskSummary } from '@onecare/events/src/contracts/clinician-task-summary';
import type { ClinicianTaskDetail } from '@onecare/events/src/contracts/clinician-task-detail';

export type TaskPriority = ClinicianTaskSummary['priority'];
export type TaskStatus = ClinicianTaskSummary['status'];

export interface QueueFilters {
  clinicId: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  assignee?: 'me' | 'unassigned' | 'any';
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export type QueueErrorCode = 'conflict' | 'not_found' | 'network';

export class QueueGatewayError extends Error {
  code: QueueErrorCode;
  correlationId?: string;

  constructor(code: QueueErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = 'QueueGatewayError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

export interface QueueGateway {
  list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string }>;
  getById(id: string): Promise<ClinicianTaskDetail>;
  assign(id: string, assignee?: string): Promise<ClinicianTaskDetail>;
  unassign(id: string): Promise<ClinicianTaskDetail>;
  resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail>;
  scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail>;
  bookSlot(id: string, slotId: string): Promise<ClinicianTaskDetail>;
}
