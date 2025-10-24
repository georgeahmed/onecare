// AUTO-GENERATED from schemas. DO NOT EDIT.

export type BookingAssistedOutcomeType = "booked" | "no_time" | "pharmacy_referral_sent";
export type BookingAssistedOutcomeSlot = {
  start: string;
  end: string;
  location?: string | null;
  serviceType?: string | null;
} | null;

export interface BookingAssistedOutcome {
  taskId: string;
  patientId: string;
  outcome: BookingAssistedOutcomeType;
  appointmentId?: string;
  slot?: BookingAssistedOutcomeSlot;
  notes?: string;
  recordedAt: string;
  recordedBy: string;
}
