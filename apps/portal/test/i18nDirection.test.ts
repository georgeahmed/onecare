/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { getAvailableLocales, getLocaleDirection } from '../src/i18n';

describe('locale metadata', () => {
  it('exposes Arabic locale with RTL direction', () => {
    expect(getAvailableLocales()).toContain('ar');
    expect(getLocaleDirection('ar')).toBe('rtl');
  });
});
