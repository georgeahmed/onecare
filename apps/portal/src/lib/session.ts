import { sanitizeText } from './security';

const PATIENT_CONTEXT_STORAGE_KEY = 'onecare.portal.patient';
export const PATIENT_CONTEXT_EVENT = 'onecare:patient-context';
const PATIENT_CONTEXT_TTL_MS = 4 * 60 * 60 * 1000;

export interface PatientContext {
  id: string;
}

const getStorage = (): Storage | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }
  try {
    if (window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // ignore
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const hasStorage = (): boolean => Boolean(getStorage());

const serialize = (context: PatientContext): string =>
  JSON.stringify({
    id: context.id,
    updatedAt: Date.now(),
  });

const isExpired = (updatedAt: number | undefined): boolean => {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return true;
  }
  return Date.now() - updatedAt > PATIENT_CONTEXT_TTL_MS;
};

const deserialize = (raw: string | null): PatientContext | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; updatedAt?: unknown };
    if (typeof parsed?.id !== 'string') {
      return null;
    }
    if (isExpired(parsed.updatedAt as number | undefined)) {
      return null;
    }
    const id = sanitizeText(parsed.id, 120);
    return id ? { id } : null;
  } catch {
    return null;
  }
};

export const readPatientContext = (): PatientContext | null => {
  if (!hasStorage()) {
    return null;
  }
  try {
    const storage = getStorage();
    if (!storage) return null;
    const envelope = storage.getItem(PATIENT_CONTEXT_STORAGE_KEY);
    const deserialized = deserialize(envelope);
    if (!deserialized && envelope) {
      storage.removeItem(PATIENT_CONTEXT_STORAGE_KEY);
    }
    return deserialized;
  } catch {
    return null;
  }
};

export const persistPatientContext = (context: PatientContext): void => {
  if (!hasStorage()) {
    return;
  }
  const storage = getStorage();
  if (!storage) {
    return;
  }
  const sanitizedId = sanitizeText(context.id, 120);
  if (!sanitizedId) {
    clearPatientContext();
    return;
  }
  try {
    storage.setItem(
      PATIENT_CONTEXT_STORAGE_KEY,
      serialize({ id: sanitizedId }),
    );
    notify({ id: sanitizedId });
  } catch {
    // Ignore persistence failures so the UI remains responsive.
  }
};

export const clearPatientContext = (): void => {
  if (!hasStorage()) {
    return;
  }
  try {
    const storage = getStorage();
    storage?.removeItem(PATIENT_CONTEXT_STORAGE_KEY);
    notify(null);
  } catch {
    // Ignore failures (private mode, quota, etc.).
  }
};

export const PATIENT_CONTEXT_KEY = PATIENT_CONTEXT_STORAGE_KEY;
const notify = (context: PatientContext | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent(PATIENT_CONTEXT_EVENT, {
        // Avoid broadcasting PHI across scripts; listeners should re-read from storage.
        detail: context ? { changed: true } : null,
      }),
    );
  } catch {
    // Ignore notification failures.
  }
};
