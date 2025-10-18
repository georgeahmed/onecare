export interface FairnessConfig {
  telephoneMinFraction: number;
}

const DEFAULT_TELEPHONE_MIN_FRACTION = 0.15;

function parseFraction(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric > 1) {
    const percentage = numeric / 100;
    if (percentage > 0 && percentage <= 1) return percentage;
  }
  if (numeric <= 0) return undefined;
  if (numeric > 1) return undefined;
  return numeric;
}

export function resolveFairnessConfig(env: Record<string, string | undefined>): FairnessConfig {
  const parsed = parseFraction(env.VITE_BOOKING_TELEPHONE_MIN_FRACTION);
  const telephoneMinFraction = parsed ?? DEFAULT_TELEPHONE_MIN_FRACTION;
  return { telephoneMinFraction };
}

export function getFairnessConfig(): FairnessConfig {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  return resolveFairnessConfig(env);
}
