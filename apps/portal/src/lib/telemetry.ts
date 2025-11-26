declare const process: { env?: Record<string, string | undefined> } | undefined;

interface TelemetryDetail {
  event: string;
  correlationId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const SESSION_CORRELATION_STORAGE_KEY = 'onecare.portal.sessionCorrelationId';
const SESSION_CORRELATION_TTL_MS = 6 * 60 * 60 * 1000;

const hasWindow = (): boolean => typeof window !== 'undefined';

let cachedSessionCorrelationId: string | null = null;

export const createCorrelationId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `corr-${Date.now().toString(36)}-${random}`;
};

type StoredCorrelation = { id: string; createdAt: number };

const getSessionStorage = (): Storage | null => {
  if (!hasWindow()) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const readStoredSessionCorrelationId = (): string | null => {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_CORRELATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCorrelation;
    if (!parsed?.id || typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'number') {
      storage.removeItem(SESSION_CORRELATION_STORAGE_KEY);
      return null;
    }
    if (Date.now() - parsed.createdAt > SESSION_CORRELATION_TTL_MS) {
      storage.removeItem(SESSION_CORRELATION_STORAGE_KEY);
      return null;
    }
    return parsed.id;
  } catch {
    return null;
  }
};

const persistSessionCorrelationId = (value: string): void => {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const envelope: StoredCorrelation = { id: value, createdAt: Date.now() };
    storage.setItem(SESSION_CORRELATION_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // ignore persistence failures
  }
};

export const getSessionCorrelationId = (): string => {
  if (cachedSessionCorrelationId) {
    return cachedSessionCorrelationId;
  }
  const stored = readStoredSessionCorrelationId();
  if (stored) {
    cachedSessionCorrelationId = stored;
    return stored;
  }
  const generated = createCorrelationId();
  cachedSessionCorrelationId = generated;
  persistSessionCorrelationId(generated);
  return generated;
};

export const startTimer = (): (() => number) => {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return () => {
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return end - start;
  };
};

export const recordRumEvent = (event: string, detail: Record<string, unknown> = {}): void => {
  if (!hasWindow()) return;
  const payload: TelemetryDetail = {
    event,
    correlationId: getSessionCorrelationId(),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent<TelemetryDetail>('onecare:rum', {
      detail: redactForLog(payload) as TelemetryDetail,
    }),
  );
};

export const safeLog = (message: string, context: Record<string, unknown> = {}): void => {
  const isProductionEnv =
    (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'production') ||
    (typeof import.meta !== 'undefined' && (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true);
  if (isProductionEnv) return;
  // eslint-disable-next-line no-console
  console.debug(`[onecare] ${message}`, redactForLog(context));
};

export const reportPerformanceMetric = (
  metric: string,
  value: number,
  rating: 'good' | 'needs-improvement' | 'poor',
  extra: Record<string, unknown> = {}
): void => {
  recordRumEvent('performance.metric', {
    metric,
    value,
    rating,
    ...extra
  });
  if (rating !== 'good') {
    safeLog('performance.metric', { metric, value, rating, ...extra });
  }
};
import { redactForLog } from './security';
