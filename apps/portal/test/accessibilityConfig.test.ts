/// <reference types="vitest/globals" />

import { transformAccessibilityConfig } from '../src/lib/config';

describe('transformAccessibilityConfig', () => {
  it('enables interpreter support when languages provided', () => {
    const result = transformAccessibilityConfig({
      interpreter_languages: ['en', 'ur'],
      offer_bsl: true,
    });

    expect(result.enabled).toBe(true);
    expect(result.interpreterLanguages).toEqual(['en', 'ur']);
    expect(result.offerBsl).toBe(true);
  });

  it('disables interpreter support when languages missing', () => {
    const result = transformAccessibilityConfig({ interpreter_languages: [] });

    expect(result.enabled).toBe(false);
    expect(result.interpreterLanguages).toEqual([]);
  });
});
