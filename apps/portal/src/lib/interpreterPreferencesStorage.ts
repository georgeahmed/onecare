const STORAGE_KEY = 'onecare.portal.interpreter.preferences';
const PREFERENCES_TTL_MS = 4 * 60 * 60 * 1000;

export interface StoredInterpreterPreferences {
  requiresInterpreter: boolean;
  preferredLanguages: string[];
  requiresInterpreterConfirmed?: boolean;
  storedAt?: number;
}

const isStoredInterpreterPreferences = (value: unknown): value is StoredInterpreterPreferences => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requiresInterpreter !== 'boolean') return false;
  if (!Array.isArray(record.preferredLanguages)) return false;
  if (!record.preferredLanguages.every((item) => typeof item === 'string')) return false;
  if (
    record.requiresInterpreterConfirmed !== undefined &&
    typeof record.requiresInterpreterConfirmed !== 'boolean'
  ) {
    return false;
  }
  return true;
};

export const readStoredInterpreterPreferences = (): StoredInterpreterPreferences | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredInterpreterPreferences;
  if (!isStoredInterpreterPreferences(parsed)) {
    return null;
  }
  if (typeof parsed.storedAt === 'number' && Number.isFinite(parsed.storedAt)) {
    if (Date.now() - parsed.storedAt > PREFERENCES_TTL_MS) {
      return null;
    }
  }
  return parsed;
} catch {
  return null;
}
};

export const persistInterpreterPreferences = (value: StoredInterpreterPreferences): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...value,
        storedAt: Date.now()
      })
    );
  } catch {
    // ignore write failures
  }
};

export const clearInterpreterPreferences = (): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore removal failures
  }
};
