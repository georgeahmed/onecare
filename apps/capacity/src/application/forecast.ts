import { TelemetrySnapshot, ForecastResult } from './types';

export interface ForecastOptions {
  horizonMinutes?: number;
}

const MIN_HORIZON_MINUTES = 30;
const MAX_CONFIDENCE = 0.95;
const MIN_CONFIDENCE = 0.2;

export function forecastNeedVsSupply(
  telemetry: TelemetrySnapshot,
  options: ForecastOptions = {},
): ForecastResult {
  const horizonMinutes = clampNumber(
    options.horizonMinutes ?? 120,
    MIN_HORIZON_MINUTES,
    24 * 60,
  );
  const horizonHours = horizonMinutes / 60;
  const arrivalsPerHour = Math.max(0, telemetry.arrivalsPerHour);
  const queueDepth = Math.max(0, telemetry.queueDepth);
  const noShowRate = clampNumber(telemetry.noShowRate, 0, 0.9);
  const staffingLevel = Math.max(0, telemetry.staffingLevel);

  const projectedArrivals = arrivalsPerHour * horizonHours;
  const projectedNeed = queueDepth + projectedArrivals;

  const rawSupply = staffingLevel * horizonHours;
  const effectiveSupply = rawSupply * (1 - noShowRate);

  const delta = projectedNeed - effectiveSupply;

  const loadRatio = effectiveSupply > 0 ? projectedNeed / effectiveSupply : projectedNeed > 0 ? 2 : 0;
  const stability = 1 - noShowRate;
  const staffingSignal = staffingLevel > 0 ? Math.min(staffingLevel / 12, 1) : 0;

  const baseConfidence = clampNumber(
    0.6 + (0.25 * stability) + (0.1 * staffingSignal),
    MIN_CONFIDENCE,
    MAX_CONFIDENCE,
  );
  const variabilityPenalty = Math.min(
    0.4,
    Math.abs(loadRatio - 1) * 0.2 + queueDepth * 0.01,
  );
  const confidence = clampNumber(baseConfidence - variabilityPenalty, MIN_CONFIDENCE, MAX_CONFIDENCE);

  const volatility = Math.max(1, Math.sqrt(projectedNeed + effectiveSupply + 1));
  const spread = volatility * (1 - confidence);

  return {
    delta,
    confidence,
    band: {
      lower: delta - spread,
      upper: delta + spread,
    },
    horizonMinutes,
    need: projectedNeed,
    supply: effectiveSupply,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
