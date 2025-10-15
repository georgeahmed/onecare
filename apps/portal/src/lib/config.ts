export interface AccessibilityConfig {
  interpreterLanguages?: string[];
  offerBsl?: boolean;
  collectPatientPrefs?: string[];
}

export interface TransformedAccessibilityConfig extends AccessibilityConfig {
  enabled: boolean;
}

export const transformAccessibilityConfig = (raw: unknown): TransformedAccessibilityConfig => {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false };
  }
  const record = raw as Record<string, unknown>;
  const interpreterLanguages = Array.isArray(record.interpreter_languages)
    ? record.interpreter_languages.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const offerBsl = Boolean(record.offer_bsl);
  const collectPatientPrefs = Array.isArray(record.collect_patient_prefs)
    ? record.collect_patient_prefs
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().toLowerCase())
    : undefined;
  const enabled = interpreterLanguages.length > 0;
  return { enabled, interpreterLanguages, offerBsl, collectPatientPrefs };
};
