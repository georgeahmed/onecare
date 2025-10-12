import { describe, it, expect } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import { IntakeState, resetDedupCache, type TriageContext } from '../src/application/triage.state';

function buildContext(scoreWeights: Partial<Record<string, number>>, features: Record<string, number>): TriageContext {
  const config: ResolvedConfig = {
    practiceId: 'demo',
    triage: { score_weights: scoreWeights },
  };

  return {
    id: 'triage-ctx',
    config,
    features,
  };
}

describe('IntakeState', () => {
  beforeEach(() => {
    resetDedupCache();
  });

  it('computes and stores the triage score in context before moving to Scored', async () => {
    const state = new IntakeState();
    const ctx = buildContext(
      { acuity: 1, risk: 0.5, complexity: 0.25, time: 0.4, capacity: 0.1 },
      { acuity: 0.9, risk: 0.6, complexity: 0.3, time: 0.5, capacity: 0.8 },
    );

    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    const expected =
      1 * 0.9 +
      0.5 * 0.6 +
      0.25 * 0.3 +
      0.4 * 0.5 +
      0.1 * 0.8;

    expect(next).toBe('Scored');
    expect(ctx.score).toBeCloseTo(expected, 6);
  });

  it('marks submissions as duplicate when similar within the dedup window', async () => {
    const state = new IntakeState();
    const configWeights = { acuity: 1 };
    const baseContext = {
      id: 'triage-ctx',
      config: {
        practiceId: 'demo',
        triage: {
          score_weights: configWeights,
          dedup_window: 'PT2H',
          sim_threshold: 0.3,
        },
      } as ResolvedConfig,
      features: { acuity: 1 },
      patientId: 'patient-123',
      narrative: 'Patient reports chest pain and dizziness',
    };

    const firstCtx: TriageContext = { ...baseContext, now: 0 };
    const secondCtx: TriageContext = {
      ...baseContext,
      now: 30 * 60 * 1_000,
      narrative: 'Dizziness with chest pain continues',
    };

    await state.handle(firstCtx, { type: 'triage.evaluate' });
    const next = await state.handle(secondCtx, { type: 'triage.evaluate' });

    expect(next).toBe('Scored');
    expect(secondCtx.isDuplicate).toBe(true);
  });

  it('does not flag submissions outside the dedup window or below similarity threshold', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT1H',
        sim_threshold: 0.7,
      },
    };

    const firstCtx: TriageContext = {
      id: 'ctx-one',
      config,
      features: { acuity: 1 },
      patientId: 'patient-456',
      narrative: 'Sore throat and mild fever',
      now: 0,
    };

    const dissimilarCtx: TriageContext = {
      id: 'ctx-two',
      config,
      features: { acuity: 0.5 },
      patientId: 'patient-456',
      narrative: 'Sprained ankle pain',
      now: 15 * 60 * 1_000,
    };

    const lateCtx: TriageContext = {
      id: 'ctx-three',
      config,
      features: { acuity: 0.6 },
      patientId: 'patient-456',
      narrative: 'Sore throat returning',
      now: 3 * 60 * 60 * 1_000,
    };

    await state.handle(firstCtx, { type: 'triage.evaluate' });
    await state.handle(dissimilarCtx, { type: 'triage.evaluate' });
    await state.handle(lateCtx, { type: 'triage.evaluate' });

    expect(dissimilarCtx.isDuplicate).not.toBe(true);
    expect(lateCtx.isDuplicate).not.toBe(true);
  });
});
