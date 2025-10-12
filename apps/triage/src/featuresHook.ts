import { logger } from '@onecare/observability';
import type { FeatureStore } from '@onecare/ports';

export type FeatureLogSource = 'triage' | 'safety';

export interface FeatureLogInput {
  source: FeatureLogSource;
  store?: FeatureStore;
  correlationId?: string | null;
  patientId?: string | null;
  entityId?: string | null;
  features?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function featureLoggingEnabled(): boolean {
  return parseBooleanFlag(process.env.FEATURE_LOGGING);
}

function buildFeatureKey({ source, entityId, correlationId }: FeatureLogInput): string {
  const safeSource = source || 'unknown';
  const parts = [safeSource];
  if (entityId) parts.push(entityId);
  if (correlationId) {
    parts.push(correlationId);
  } else {
    parts.push(String(Date.now()));
  }
  return parts.join(':');
}

const clone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

export async function logFeatureVector(input: FeatureLogInput): Promise<void> {
  if (!featureLoggingEnabled()) {
    return;
  }

  const store = input.store;
  if (!store) {
    logger.debug('feature logging skipped; featureStore missing', {
      source: input.source,
      correlationId: input.correlationId,
    });
    return;
  }

  const features = input.features ? clone(input.features) : {};
  const payload: Record<string, unknown> = {
    source: input.source,
    recordedAt: new Date().toISOString(),
    correlationId: input.correlationId,
    patientId: input.patientId,
    metadata: clone(input.metadata ?? {}),
    features,
  };

  const key = buildFeatureKey(input);

  try {
    await store.putFeatures(key, payload);
    logger.debug('feature vector logged', {
      key,
      source: input.source,
      correlationId: input.correlationId,
    });
  } catch (err) {
    logger.warn('feature logging failed', {
      source: input.source,
      correlationId: input.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
