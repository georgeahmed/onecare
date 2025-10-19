/// <reference types="vitest/globals" />

import { transformAccessibilityConfig } from '../src/lib/config';

describe('transformAccessibilityConfig', () => {
  it('enables interpreter support when languages provided', () => {
    const result = transformAccessibilityConfig({
      interpreter_languages: ['en', 'ur'],
      offer_bsl: true,
      collect_patient_prefs: [' Remember_Interpreter '],
    });

    expect(result.enabled).toBe(true);
    expect(result.interpreterLanguages).toEqual(['en', 'ur']);
    expect(result.offerBsl).toBe(true);
    expect(result.collectPatientPrefs).toEqual(['remember_interpreter']);
  });

  it('disables interpreter support when languages missing', () => {
    const result = transformAccessibilityConfig({ interpreter_languages: [] });

    expect(result.enabled).toBe(false);
    expect(result.interpreterLanguages).toEqual([]);
  });

  it('parses offer_bsl string flags safely', () => {
    const truthy = transformAccessibilityConfig({
      interpreter_languages: ['en'],
      offer_bsl: 'yes'
    });
    const falsy = transformAccessibilityConfig({
      interpreter_languages: ['en'],
      offer_bsl: 'false'
    });

    expect(truthy.offerBsl).toBe(true);
    expect(falsy.offerBsl).toBe(false);
  });
});
