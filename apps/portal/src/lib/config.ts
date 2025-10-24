export interface AccessibilityConfig {
  interpreterLanguages?: string[];
  offerBsl?: boolean;
  collectPatientPrefs?: string[];
}

export interface TransformedAccessibilityConfig extends AccessibilityConfig {
  enabled: boolean;
}

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return undefined;
  }
  return undefined;
};

export const transformAccessibilityConfig = (raw: unknown): TransformedAccessibilityConfig => {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false };
  }
  const record = raw as Record<string, unknown>;
  const interpreterLanguages = Array.isArray(record.interpreter_languages)
    ? record.interpreter_languages.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const offerBsl = normalizeBoolean(record.offer_bsl) ?? false;
  const collectPatientPrefs = Array.isArray(record.collect_patient_prefs)
    ? record.collect_patient_prefs
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().toLowerCase())
    : undefined;
  const enabled = interpreterLanguages.length > 0;
  return { enabled, interpreterLanguages, offerBsl, collectPatientPrefs };
};
