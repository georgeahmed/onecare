import { sanitizeText } from './security';

const PATIENT_CONTEXT_STORAGE_KEY = 'onecare.portal.patient';
export const PATIENT_CONTEXT_EVENT = 'onecare:patient-context';

export interface PatientContext {
  id: string;
}

const hasStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const serialize = (context: PatientContext): string =>
  JSON.stringify({
    id: context.id,
    updatedAt: Date.now(),
  });

const deserialize = (raw: string | null): PatientContext | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed?.id !== 'string') {
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
    return deserialize(window.localStorage.getItem(PATIENT_CONTEXT_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const persistPatientContext = (context: PatientContext): void => {
  if (!hasStorage()) {
    return;
  }
  const sanitizedId = sanitizeText(context.id, 120);
  if (!sanitizedId) {
    clearPatientContext();
    return;
  }
  try {
    window.localStorage.setItem(
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
    window.localStorage.removeItem(PATIENT_CONTEXT_STORAGE_KEY);
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
        detail: context,
      }),
    );
  } catch {
    // Ignore notification failures.
  }
};
