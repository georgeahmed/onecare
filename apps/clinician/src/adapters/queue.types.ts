import type { ClinicianTaskSummary, ClinicianTaskDetail } from '@onecare/events';

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

export interface QueueGateway {
  list(filters: QueueFilters): Promise<{ items: ClinicianTaskSummary[]; nextCursor?: string }>;
  getById(id: string): Promise<ClinicianTaskDetail>;
  assign(id: string, assignee?: string): Promise<ClinicianTaskDetail>;
  unassign(id: string): Promise<ClinicianTaskDetail>;
  resolve(id: string, outcome: string, note?: string): Promise<ClinicianTaskDetail>;
  scheduleCallback(id: string, whenIso: string, note?: string): Promise<ClinicianTaskDetail>;
  bookSlot(id: string, slotId: string): Promise<ClinicianTaskDetail>;
}
