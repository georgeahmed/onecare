import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { ResolvedConfig } from '@onecare/config';

export interface TelemetrySnapshot {
  arrivalsPerHour: number;
  queueDepth: number;
  noShowRate: number;
  staffingLevel: number;
  collectedAt: string;
}

export interface TelemetryHealth {
  ok: boolean;
  reason?: string;
  checkedAt?: string;
}

export interface TelemetrySource {
  getArrivalsPerHour(): Promise<number>;
  getQueueDepth(): Promise<number>;
  getNoShowRate(): Promise<number>;
  getStaffingLevel(): Promise<number>;
  health?(): Promise<TelemetryHealth | undefined> | TelemetryHealth | undefined;
}

export interface ForecastBand {
  lower: number;
  upper: number;
}

export interface ForecastResult {
  delta: number;
  confidence: number;
  band: ForecastBand;
  horizonMinutes: number;
  need: number;
  supply: number;
}

export type ReleaseCap = 'delta' | 'maxFraction' | 'reserve' | 'held';

export interface ReleasePlan {
  slotsToRelease: number;
  releaseFraction: number;
  heldSlotsBefore: number;
  heldSlotsAfter: number;
  maxFractionSlots: number;
  minReserveSlots: number;
  cappedBy: ReleaseCap[];
}

export interface ReleaseDecision {
  outcome: 'release' | 'skip';
  reason: string;
  plan: ReleasePlan;
  deltaThreshold: number;
  confidenceThreshold: number;
  forecastDelta: number;
  forecastConfidence: number;
}

export interface CapacityAuditRecord {
  practiceId: string;
  runId: string;
  timestamp: string;
  correlationId?: string;
  dryRun: boolean;
  outcome: ReleaseDecision['outcome'];
  reason: string;
  release: {
    slots: number;
    fraction: number;
    heldBefore: number;
    heldAfter: number;
    cappedBy: ReleaseCap[];
    maxFractionSlots: number;
    minReserveSlots: number;
    deltaThreshold: number;
    confidenceThreshold: number;
  };
  forecast: {
    delta: number;
    confidence: number;
    lowerBound: number;
    upperBound: number;
    horizonMinutes: number;
    need: number;
    supply: number;
  };
}

export interface CapacityAuditor {
  record(entry: CapacityAuditRecord): Promise<void>;
}

export interface ReleaseMeta {
  practiceId: string;
  runId: string;
  correlationId?: string;
  dryRun: boolean;
}

export interface ReleaseExecutor {
  apply(plan: ReleasePlan, meta: ReleaseMeta): Promise<void>;
}

export interface CapacityWindow {
  totalSlots: number;
  heldSlots: number;
}

export interface CapacityContext extends MachineContext {
  practiceId: string;
  correlationId?: string;
  config: ResolvedConfig;
  telemetrySource: TelemetrySource;
  capacityWindow: CapacityWindow;
  releaseExecutor?: ReleaseExecutor;
  auditor?: CapacityAuditor;
  dryRun?: boolean;
  forecastHorizonMinutes?: number;
  clock?: () => Date;
  telemetryHealth?: TelemetryHealth;
  telemetry?: TelemetrySnapshot;
  forecast?: ForecastResult;
  decision?: ReleaseDecision;
}

export interface CapacityEvent extends MachineEvent {
  type: 'capacity.tick' | 'capacity.run';
  payload?: Record<string, unknown>;
}
