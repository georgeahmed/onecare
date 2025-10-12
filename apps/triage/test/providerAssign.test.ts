import { describe, it, expect } from 'vitest';
import { assignProvider, type AssignmentInput, type AssignmentWeights } from '../src/application/providerAssign';

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

  it('returns undefined when no providers supplied', () => {
    expect(assignProvider(task, [], weights)).toBeUndefined();
  });

  it('selects provider with highest weighted score', () => {
    const providers = [
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

    const owner = assignProvider(task, providers, weights);
    expect(owner).toBe('provider-b');
  });

  it('falls back to lexicographic id on tie', () => {
    const providers = [
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

    const owner = assignProvider(task, providers, weights);
    expect(owner).toBe('provider-a');
  });
});
