interface TelemetryDetail {
  event: string;
  correlationId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = ['patient', 'token', 'auth', 'password', 'secret', 'idempotency'];

const hasWindow = (): boolean => typeof window !== 'undefined';

export const createCorrelationId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `corr-${Date.now().toString(36)}-${random}`;
};

export const startTimer = (): (() => number) => {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return () => {
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return end - start;
  };
};

const sanitize = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEYS.some((token) => key.toLowerCase().includes(token))) {
      result[key] = '[redacted]';
      continue;
    }
    if (typeof raw === 'string' && raw.length > 128) {
      result[key] = `${raw.slice(0, 125)}…`;
      continue;
    }
    result[key] = sanitize(raw);
  }
  return result;
};

export const recordRumEvent = (event: string, detail: Record<string, unknown> = {}): void => {
  if (!hasWindow()) return;
  const payload: TelemetryDetail = {
    event,
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent<TelemetryDetail>('onecare:rum', {
      detail: sanitize(payload) as TelemetryDetail,
    }),
  );
};

export const safeLog = (message: string, context: Record<string, unknown> = {}): void => {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') return;
  // eslint-disable-next-line no-console
  console.debug(`[onecare] ${message}`, sanitize(context));
};
