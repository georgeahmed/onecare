import { describe, expect, it } from 'vitest';

import type { FeatureSnapshot } from '../src/types';
import {
  getFeatureView,
  listFeatureViews,
  materializeFeatureView,
  materializeAllFeatureViews,
} from '../src/views';

const baseSnapshots: FeatureSnapshot[] = [
  {
    featureSet: 'triage-core',
    entityId: 'patient-001',
    generatedAt: '2025-01-07T09:00:00.000Z',
    payload: {
      schemaVersion: 'v1.0.0',
      generatedAt: '2025-01-07T09:00:00.000Z',
      acuity: 0.8,
      risk: 0.2,
      complexity: 0.4,
      time: 0.6,
      capacity: 0.3,
      compositeScore: 0.7,
    },
  },
  {
    featureSet: 'triage-core',
    entityId: 'patient-001',
    generatedAt: '2025-01-08T11:30:00.000Z',
    payload: {
      schemaVersion: 'v1.0.0',
      generatedAt: '2025-01-08T11:30:00.000Z',
      acuity: 0.5,
      risk: 0.5,
      complexity: 0.2,
      time: 0.4,
      capacity: 0.5,
      compositeScore: 0.55,
    },
  },
  {
    featureSet: 'triage-core',
    entityId: 'patient-001',
    generatedAt: '2025-01-09T12:00:00.000Z',
    payload: {
      schemaVersion: 'v1.0.0',
      generatedAt: '2025-01-09T12:00:00.000Z',
      acuity: 0.9,
      risk: 0.4,
      complexity: 0.5,
      time: 0.8,
      capacity: 0.1,
      compositeScore: 0.75,
    },
  },
  {
    featureSet: 'triage-core',
    entityId: 'patient-002',
    generatedAt: '2025-01-09T10:15:00.000Z',
    payload: {
      schemaVersion: 'v1.0.0',
      generatedAt: '2025-01-09T10:15:00.000Z',
      acuity: 0.3,
      risk: 0.6,
      complexity: 0.2,
      time: 0.1,
      capacity: 0.4,
      compositeScore: 0.35,
    },
  },
];

describe('feature view registry', () => {
  it('lists registered feature views with metadata', () => {
    const views = listFeatureViews();
    const triageView = views.find((view) => view.name === 'triage-core.sliding-windows');
    expect(triageView).toBeDefined();
    expect(triageView?.version).toBe('v1');
    expect(triageView?.sourceFeatureSet).toBe('triage-core');
    expect(triageView?.targetFeatureSet).toBe('triage-core-windowed');
  });

  it('resolves a view by name', () => {
    const definition = getFeatureView('triage-core.sliding-windows');
    expect(definition).not.toBeNull();
    expect(definition?.windows).toHaveLength(5);
  });
});

describe('triage sliding window materialisation', () => {
  it('aggregates counts and averages per entity', () => {
    const materialised = materializeFeatureView('triage-core.sliding-windows', {
      snapshots: baseSnapshots,
      asOf: '2025-01-09T12:00:00.000Z',
    });
    expect(materialised).toHaveLength(2);

    const patientOne = materialised.find((snapshot) => snapshot.entityId === 'patient-001');
    expect(patientOne).toBeDefined();
    expect(patientOne?.featureSet).toBe('triage-core-windowed');
    expect(patientOne?.metadata?.viewName).toBe('triage-core.sliding-windows');
    const payload = (patientOne?.payload ?? {}) as Record<string, unknown>;
    const counts = (payload.counts ?? {}) as Record<string, number>;
    expect(counts['1d']).toBe(1);
    expect(counts['7d']).toBe(3);
    const averages = (payload.averages ?? {}) as Record<string, Record<string, number | null>>;
    expect(averages.acuity?.['1d']).toBeCloseTo(0.9, 5);
    const latest = (payload.latest ?? {}) as Record<string, unknown>;
    expect(typeof latest.acuity === 'number').toBe(true);
  });

  it('materialises all registered views at once', () => {
    const result = materializeAllFeatureViews({
      snapshots: baseSnapshots,
      asOf: '2025-01-09T12:00:00.000Z',
    });
    expect(result['triage-core.sliding-windows']).toHaveLength(2);
  });
});
