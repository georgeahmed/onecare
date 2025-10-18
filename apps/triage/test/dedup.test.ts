import { describe, it, expect, beforeEach } from 'vitest';
import { getCounterRecords, getHistogramRecords, resetMetrics } from '@onecare/observability';
import { DedupStore } from '../src/application/dedup';

describe('DedupStore', () => {
  let store: DedupStore;

beforeEach(() => {
  resetMetrics();
  store = new DedupStore({ maxEntriesPerPatient: 3 });
});

  it('identifies duplicates within the window above threshold', () => {
    const windowMs = 60 * 60 * 1_000;
    const threshold = 0.5;

    const first = store.evaluate({
      patientId: 'patient-1',
      narrative: 'Patient reports chest pain and dizziness',
      now: 0,
      windowMs,
      threshold,
    });

    expect(first.isDuplicate).toBe(false);

    const second = store.evaluate({
      patientId: 'patient-1',
      narrative: 'Chest pains with continued dizziness',
      now: 5 * 60 * 1_000,
      windowMs,
      threshold,
    });

    expect(second.isDuplicate).toBe(true);
    expect(second.similarity).toBeGreaterThanOrEqual(threshold);
    expect(second.reference?.narrative).toContain('chest pain');
    expect(getCounterRecords('triage.dedup.hit')).toHaveLength(1);
    expect(getCounterRecords('triage.dedup.miss')).toHaveLength(1);
    expect(getHistogramRecords('triage.dedup.similarity').length).toBeGreaterThan(0);
  });

  it('drops stale entries outside the dedup window', () => {
    const windowMs = 10 * 1_000;
    const threshold = 0.5;

    store.evaluate({
      patientId: 'patient-2',
      narrative: 'Initial submission',
      now: 0,
      windowMs,
      threshold,
    });

    const result = store.evaluate({
      patientId: 'patient-2',
      narrative: 'Follow up submission',
      now: 20 * 1_000,
      windowMs,
      threshold,
    });

    expect(result.isDuplicate).toBe(false);
    expect(store.count('patient-2')).toBe(1);
  });

  it('enforces per-patient history limits', () => {
    const windowMs = 60_000;
    const threshold = 0.5;

    for (let i = 0; i < 10; i += 1) {
      store.evaluate({
        patientId: 'patient-3',
        narrative: `Submission ${i}`,
        now: i * 1_000,
        windowMs,
        threshold,
      });
    }

    expect(store.count('patient-3')).toBeLessThanOrEqual(3);
    expect(getCounterRecords('triage.dedup.miss').length).toBeGreaterThan(0);
    expect(getCounterRecords('triage.dedup.hit').length).toBeGreaterThan(0);
});
});
