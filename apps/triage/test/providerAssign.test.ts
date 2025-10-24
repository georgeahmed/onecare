import { describe, it, expect } from 'vitest';
import {
  assignProvider,
  type AssignmentInput,
  type AssignmentWeights,
  type FairnessConfig,
  type ProviderCandidate,
} from '../src/application/providerAssign';
import { resetMetrics, getCounterRecords, getHistogramRecords } from '@onecare/observability';

describe('assignProvider', () => {
  const task: AssignmentInput = {
    taskId: 'task-1',
    patientId: 'patient-1',
    priority: 'URGENT',
  };

  const weights: AssignmentWeights = {
    availability: 1,
    workload: 1,
    continuity: 0.5,
    resolution_rate: 0.2,
    distance: 0.3,
    fairness: 0.4,
  };

  beforeEach(() => {
    resetMetrics();
  });

  it('returns undefined when no providers supplied', () => {
    const decision = assignProvider(task, [], weights);
    expect(decision.selected).toBeUndefined();
    expect(decision.ranking).toHaveLength(0);
  });

  it('selects provider with highest weighted score', () => {
    const providers: ProviderCandidate[] = [
      {
        id: 'provider-a',
        availability: 0.7,
        workload: 0.6,
        continuity: 0.4,
        resolutionRate: 0.9,
        distance: 0.2,
        fairness: 0.8,
      },
      {
        id: 'provider-b',
        availability: 0.85,
        workload: 0.4,
        continuity: 0.6,
        resolutionRate: 0.7,
        distance: 0.3,
        fairness: 0.6,
      },
      {
        id: 'provider-c',
        availability: 0.5,
        workload: 0.2,
        continuity: 0.9,
        resolutionRate: 0.6,
        distance: 0.7,
        fairness: 0.9,
      },
    ];

    const decision = assignProvider(task, providers, weights);
    expect(decision.selected?.id).toBe('provider-b');
    expect(decision.ranking[0]?.id).toBe('provider-b');
  });

  it('falls back to lexicographic id on tie', () => {
    const providers: ProviderCandidate[] = [
      {
        id: 'provider-z',
        availability: 0.8,
        workload: 0.2,
        continuity: 0.5,
        resolutionRate: 0.6,
        distance: 0.4,
        fairness: 0.7,
      },
      {
        id: 'provider-a',
        availability: 0.8,
        workload: 0.2,
        continuity: 0.5,
        resolutionRate: 0.6,
        distance: 0.4,
        fairness: 0.7,
      },
    ];

    const decision = assignProvider(task, providers, weights);
    expect(decision.selected?.id).toBe('provider-a');
  });

  it('enforces fairness floors when configured', () => {
    const fairness: FairnessConfig = { maxShare: 0.6 };
    const providers: ProviderCandidate[] = [
      {
        id: 'provider-a',
        availability: 0.9,
        workload: 0.4,
        continuity: 0.5,
        resolutionRate: 0.7,
        distance: 0.4,
        fairness: 0.9,
      },
      {
        id: 'provider-b',
        availability: 0.7,
        workload: 0.4,
        continuity: 0.5,
        resolutionRate: 0.6,
        distance: 0.4,
        fairness: 0.3,
      },
    ];

    const decision = assignProvider(task, providers, weights, fairness);
    expect(decision.selected?.id).toBe('provider-b');
    const reasons = decision.ranking.find((entry) => entry.id === 'provider-a')?.reasons ?? [];
    expect(reasons).toContain('fairness_floor_hit');
  });

  it('prefers continuity provider on tie and emits metrics', () => {
    const providers: ProviderCandidate[] = [
      {
        id: 'provider-a',
        availability: 0.8,
        workload: 0.3,
        continuity: 0.8,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
      },
      {
        id: 'provider-b',
        availability: 0.8,
        workload: 0.3,
        continuity: 0.4,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
      },
    ];

    const decision = assignProvider(
      { ...task, continuityProviderId: 'provider-a', correlationId: 'corr-123' },
      providers,
      weights,
    );

    expect(decision.selected?.id).toBe('provider-a');
    expect(decision.ranking[0]?.reasons).toContain('continuity_high');
    expect(decision.ranking[0]?.reasons).toContain('continuity_boost');

    const selectedRecords = getCounterRecords('triage.assignment.selected');
    expect(selectedRecords[0]?.attributes?.provider).toBe('provider-a');
    const rankingRecords = getHistogramRecords('triage.assignment.rank_position');
    expect(rankingRecords.length).toBe(2);
    const durationRecords = getHistogramRecords('triage.assignment.duration_ms');
    expect(durationRecords.at(-1)?.attributes).toMatchObject({
      correlationId: 'corr-123',
      outcome: 'assigned',
    });
  });
});
