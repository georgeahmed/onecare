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
  assistedOutcome(
    id: string,
    outcome: 'booked' | 'no_time' | 'pharmacy_referral_sent',
    options?: { start?: string; end?: string; location?: string; serviceType?: string; notes?: string; patientId?: string },
  ): Promise<ClinicianTaskDetail>;
  recordCall(id: string): Promise<ClinicianTaskDetail>;
  escalate(id: string): Promise<ClinicianTaskDetail>;
  recommendWindows(
    id: string,
    options?: { windowStart?: string; windowEnd?: string; location?: string; serviceType?: string },
  ): Promise<RecommendedWindow[]>;
}

export interface RecommendedWindow {
  start: string;
  end: string;
  location?: string;
  serviceType?: string;
}
