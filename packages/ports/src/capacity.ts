export interface ReleaseSlotsPlanSummary {
  heldSlotsBefore: number;
  heldSlotsAfter: number;
  releaseFraction: number;
  maxFractionSlots: number;
  minReserveSlots: number;
  cappedBy: string[];
}

export interface ReleaseSlotsRequest {
  practiceId: string;
  runId: string;
  correlationId?: string;
  slots: number;
  channel: 'micro_release' | string;
  dryRun?: boolean;
  plan: ReleaseSlotsPlanSummary;
  reason?: string;
  requestedAt?: string;
}

export interface ReleaseSlotsResponse {
  releasedSlots: number;
  heldSlotsRemaining?: number;
  totalSlots?: number;
  holdFraction?: number;
}

export interface CapacityScheduler {
  releaseHeldSlots(request: ReleaseSlotsRequest): Promise<ReleaseSlotsResponse>;
}
