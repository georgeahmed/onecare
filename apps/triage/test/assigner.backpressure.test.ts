import { describe, expect, it, beforeEach } from 'vitest';
import {
  assignProvider,
  type ProviderCandidate,
  type AssignmentInput,
  type AssignmentWeights,
} from '../src/application/providerAssign';
import { resetMetrics, getCounterRecords } from '@onecare/observability';

const task: AssignmentInput = {
  taskId: 'task-99',
  patientId: 'patient-42',
  priority: 'SOON',
  correlationId: 'corr-backpressure',
};

const weights: AssignmentWeights = {
  availability: 1,
  workload: 1,
  continuity: 0.5,
  resolution_rate: 0.2,
  distance: 0.3,
  fairness: 0.4,
};

describe('assignProvider backpressure behaviour', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('rejects providers marked as temporarily unavailable', () => {
    const now = Date.now();
    const providers: ProviderCandidate[] = [
      {
        id: 'provider-busy',
        availability: 0.9,
        workload: 0.3,
        continuity: 0.4,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
        rejectUntil: now + 60_000,
      },
      {
        id: 'provider-open',
        availability: 0.6,
        workload: 0.4,
        continuity: 0.4,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
      },
    ];

    const decision = assignProvider(task, providers, weights, undefined, now);
    expect(decision.selected?.id).toBe('provider-open');
    expect(decision.rejected).toEqual([{ id: 'provider-busy', reason: 'backpressure' }]);

    const rejectedRecords = getCounterRecords('triage.assignment.rejected');
    expect(rejectedRecords.length).toBe(1);
    expect(rejectedRecords[0]?.attributes?.provider).toBe('provider-busy');
  });

  it('biases against providers with low capacity and high queue depth', () => {
    const providers: ProviderCandidate[] = [
      {
        id: 'low-capacity',
        availability: 0.9,
        workload: 0.3,
        continuity: 0.4,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
        capacityScore: 0.1,
        queueDepth: 20,
      },
      {
        id: 'high-capacity',
        availability: 0.8,
        workload: 0.4,
        continuity: 0.4,
        resolutionRate: 0.5,
        distance: 0.5,
        fairness: 0.4,
        capacityScore: 0.9,
        queueDepth: 2,
      },
    ];

    const decision = assignProvider(task, providers, weights);
    expect(decision.selected?.id).toBe('high-capacity');
    const lowReasons = decision.ranking.find((entry) => entry.id === 'low-capacity')?.reasons ?? [];
    expect(lowReasons).toContain('backpressure_bias');
  });
});
