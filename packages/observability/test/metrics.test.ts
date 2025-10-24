import { afterEach, describe, expect, it } from 'vitest';

import {
  createCounter,
  createGauge,
  createHistogram,
  getCounterRecords,
  getGaugeRecords,
  getGaugeValue,
  getHistogramRecords,
  resetMetrics,
} from '../src/metrics';

describe('metrics helpers', () => {
  afterEach(() => {
    resetMetrics();
  });

  it('rejects non-finite values', () => {
    const counter = createCounter('metrics.counter');
    const histogram = createHistogram('metrics.histogram');
    const gauge = createGauge('metrics.gauge');

    expect(() => counter.add(Number.POSITIVE_INFINITY)).toThrow(/requires a finite number/);
    expect(() => histogram.record(Number.NaN)).toThrow(/requires a finite number/);
    expect(() => gauge.set(Number.NEGATIVE_INFINITY)).toThrow(/requires a finite number/);
  });

  it('serializes attribute values to safe primitives', () => {
    const counter = createCounter('metrics.attributes');
    const when = new Date('2025-01-01T00:00:00.000Z');

    counter.add(1, {
      string: 'ok',
      bool: true,
      num: 2,
      date: when,
      object: { nested: true },
      ignoreNull: null,
      ignoreUndefined: undefined,
    });

    const [record] = getCounterRecords('metrics.attributes');
    expect(record.attributes).toEqual({
      string: 'ok',
      bool: true,
      num: 2,
      date: when.toISOString(),
      object: '[object Object]',
    });
  });

  it('returns defensive copies of stored records', () => {
    const histogram = createHistogram('metrics.defensive');
    histogram.record(5, { label: 'initial' });

    const snapshot = getHistogramRecords('metrics.defensive');
    expect(snapshot).toHaveLength(1);
    (snapshot[0] as { value: number }).value = 999;
    if (snapshot[0].attributes) {
      (snapshot[0].attributes as { label: string }).label = 'mutated';
    }

    const fresh = getHistogramRecords('metrics.defensive');
    expect(fresh[0].value).toBe(5);
    expect(fresh[0].attributes?.label).toBe('initial');
  });

  it('tracks gauge state and history', () => {
    const gauge = createGauge('metrics.gauge.state');
    gauge.set(10, { status: 'ready' });

    expect(getGaugeValue('metrics.gauge.state')).toBe(10);
    const records = getGaugeRecords('metrics.gauge.state');
    expect(records).toHaveLength(1);
    expect(records[0].attributes?.status).toBe('ready');
  });
});
