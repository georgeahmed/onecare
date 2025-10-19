import { describe, expect, it } from 'vitest';

import { derivePartitionKeys, planPartition } from '../src/layout';
import type { FeatureSnapshot } from '../src/types';

const snapshot: FeatureSnapshot = {
  featureSet: 'triage-core',
  entityId: 'patient-123',
  generatedAt: '2025-01-12T08:15:30.000Z',
  payload: { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T08:15:30.000Z' },
};

describe('offline layout planning', () => {
  it('derives deterministic partition keys', () => {
    const keys = derivePartitionKeys(snapshot);
    expect(keys).toMatchObject({
      featureSet: 'triage-core',
      eventDate: '2025-01-12',
    });
    expect(keys.entityBucket).toHaveLength(2);
  });

  it('builds filesystem-safe partition plan', () => {
    const plan = planPartition('/lake/features', snapshot, { fileExtension: 'parquet' });
    expect(plan.filePath).toContain('/lake/features/triage-core');
    expect(plan.filePath).toContain(`event_date=${plan.eventDate}`);
    expect(plan.filePath).toContain(`entity_bucket=${plan.entityBucket}`);
    expect(plan.filePath.endsWith('.parquet')).toBe(true);
  });

  it('respects the requested bucket count cardinality', () => {
    const keys = derivePartitionKeys(snapshot, { bucketCount: 10 });
    const bucketIndex = parseInt(keys.entityBucket, 16);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    expect(bucketIndex).toBeLessThan(10);
    expect(keys.entityBucket.length).toBe(1);
  });

  it('pads buckets for large bucket counts', () => {
    const keys = derivePartitionKeys(snapshot, { bucketCount: 70_000 });
    expect(keys.entityBucket.length).toBe(5);
    const bucketIndex = parseInt(keys.entityBucket, 16);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    expect(bucketIndex).toBeLessThan(70_000);
  });

  it('throws when bucket count is invalid', () => {
    expect(() => derivePartitionKeys(snapshot, { bucketCount: 0 })).toThrow('bucketCount must be a positive integer');
    expect(() => derivePartitionKeys(snapshot, { bucketCount: -5 })).toThrow('bucketCount must be a positive integer');
    expect(() => derivePartitionKeys(snapshot, { bucketCount: Number.NaN })).toThrow('bucketCount must be a positive integer');
  });
});
