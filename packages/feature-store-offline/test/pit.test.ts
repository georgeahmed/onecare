import { describe, expect, it } from 'vitest';

import { buildPointInTimeTable, selectPointInTime } from '../src/pit';
import type { FeatureSnapshot } from '../src/types';

const makeSnapshot = (generatedAt: string, payload: Record<string, unknown>): FeatureSnapshot => ({
  featureSet: 'triage-core',
  entityId: 'patient-123',
  generatedAt,
  payload,
});

describe('point-in-time table', () => {
  it('produces leakage-safe effective windows', () => {
    const snapshots: FeatureSnapshot[] = [
      makeSnapshot('2025-01-12T08:00:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T08:00:00.000Z', acuity: 0.2 }),
      makeSnapshot('2025-01-12T09:00:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T09:00:00.000Z', acuity: 0.6 }),
      makeSnapshot('2025-01-12T10:30:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T10:30:00.000Z', acuity: 0.4 }),
    ];

    const pitRows = buildPointInTimeTable(snapshots);
    expect(pitRows).toHaveLength(3);
    expect(pitRows[0]?.effectiveFrom).toBe('2025-01-12T08:00:00.000Z');
    expect(pitRows[0]?.effectiveTo).toBe('2025-01-12T09:00:00.000Z');
    expect(pitRows[2]?.effectiveTo).toBeNull();
  });

  it('selects the most recent snapshot before the as-of timestamp', () => {
    const snapshots: FeatureSnapshot[] = [
      makeSnapshot('2025-01-12T08:00:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T08:00:00.000Z', acuity: 0.2 }),
      makeSnapshot('2025-01-12T09:15:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T09:15:00.000Z', acuity: 0.7 }),
    ];
    const pitRows = buildPointInTimeTable(snapshots);
    const result = selectPointInTime(pitRows, {
      featureSet: 'triage-core',
      entityId: 'patient-123',
      asOf: '2025-01-12T09:30:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result?.payload.acuity).toBe(0.7);
  });

  it('returns null when no snapshot exists before the as-of timestamp', () => {
    const snapshots: FeatureSnapshot[] = [
      makeSnapshot('2025-01-12T09:15:00.000Z', { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T09:15:00.000Z', acuity: 0.7 }),
    ];
    const pitRows = buildPointInTimeTable(snapshots);
    const result = selectPointInTime(pitRows, {
      featureSet: 'triage-core',
      entityId: 'patient-123',
      asOf: '2025-01-12T08:00:00.000Z',
    });

    expect(result).toBeNull();
  });
});
