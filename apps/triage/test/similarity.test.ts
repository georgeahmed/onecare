import { describe, it, expect } from 'vitest';
import { computeSimilarity } from '../src/application/similarity';

describe('computeSimilarity', () => {
  it('calculates Jaccard similarity over shingles', () => {
    const tokensA = ['chest', 'pain', 'acute'];
    const tokensB = ['chest', 'pain', 'ongo'];

    const similarity = computeSimilarity(tokensA, tokensB, { shingleSize: 2 });
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });

  it('returns zero when there is no overlap', () => {
    const similarity = computeSimilarity(['one', 'two'], ['three', 'four']);
    expect(similarity).toBe(0);
  });
});
