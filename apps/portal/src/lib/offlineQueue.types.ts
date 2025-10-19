import type { BookingModality } from './booking';

export interface OfflineBookingJobPayload {
  slotId: string;
  patientId: string;
}

export interface OfflineBookingJobSlot {
  start: string;
  end: string;
  modality: BookingModality;
  location?: string;
}

export interface OfflineBookingJob {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  payload: OfflineBookingJobPayload;
  slot: OfflineBookingJobSlot;
  attempt: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError?: string;
}

export type OfflineQueueSnapshot = OfflineBookingJob[];
