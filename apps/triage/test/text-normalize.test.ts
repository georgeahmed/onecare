import { describe, it, expect } from 'vitest';
import { normalizeText } from '../src/application/text-normalize';

describe('normalizeText', () => {
  it('lowercases, removes stopwords, and stems tokens', () => {
    const input = 'Patient WITH High fevers and vomiting';
    const result = normalizeText(input);

    expect(result.tokens).toEqual(['patient', 'high', 'fever', 'vomit']);
    expect(result.normalized).toBe('patient high fever vomit');
  });

  it('respects custom stopwords and minimum token length', () => {
    const input = 'Short words go away';
    const result = normalizeText(input, {
      stopwords: ['short', 'go'],
      minTokenLength: 3,
      applyStemming: false,
    });

    expect(result.tokens).toEqual(['words', 'away']);
  });
});
