import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { ResolvedConfig } from '@onecare/config';
import { computeTriageScore } from '../src/application/scoring';
import { computeSimilarity } from '../src/application/similarity';
import { normalizeText } from '../src/application/text-normalize';

function buildConfig(): ResolvedConfig {
  return {
    practiceId: 'bench',
    triage: {
      score_weights: {
        acuity: 1,
        risk: 0.6,
        complexity: 0.4,
        time: 0.3,
        capacity: 0.2,
      },
    },
    priority_thresholds: {
      stat: 0.9,
      urgent: 0.7,
      soon: 0.4,
      routine: 0,
    },
  };
}

describe('triage performance baselines', () => {
  const config = buildConfig();
  const featureVector = {
    acuity: 0.95,
    risk: 0.72,
    complexity: 0.43,
    time: 0.58,
    capacity: 0.31,
  };

  it('computes triage scores within the target budget', () => {
    const iterations = 5_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      computeTriageScore(config, featureVector);
    }
    const duration = performance.now() - start;
    const perIteration = duration / iterations;
    expect(perIteration).toBeLessThan(0.08);
  });

  it('computes similarity within the target budget', () => {
  const tokensA = normalizeText(
    'Patient reports persistent chest tightness with dizziness and shortness of breath when climbing stairs.',
  ).tokens;
  const tokensB = normalizeText(
    'Ongoing shortness of breath during minor exertion with dizziness; chest discomfort noted.',
  ).tokens;
    const iterations = 5_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      computeSimilarity(tokensA, tokensB, { shingleSize: 3 });
    }
    const duration = performance.now() - start;
    const perIteration = duration / iterations;
    expect(perIteration).toBeLessThan(0.09);
  });
});
