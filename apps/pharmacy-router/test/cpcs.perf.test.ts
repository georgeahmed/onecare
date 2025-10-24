import { describe, it, expect, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { CpcsHttpClient, type CpcsServiceRequest } from '../src/adapters/cpcs.client';
import { resetMetrics, getHistogramRecords } from '@onecare/observability';

const BASE_REQUEST: CpcsServiceRequest = {
  id: 'perf-0',
  patientReference: 'patient-100',
  presentingComplaintCode: 'A01',
  consentTimestamp: '2025-10-12T10:00:00Z',
};

describe('CpcsHttpClient performance baselines', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('dispatches referrals within 20ms average budget', async () => {
    const client = new CpcsHttpClient({
      baseUrl: 'https://cpcs-perf.test',
      dispatcher: async (_org, payload) => ({
        status: 'accepted' as const,
        reference: payload.id,
      }),
    });

    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await client.sendReferral(
        'org-perf',
        { ...BASE_REQUEST, id: `perf-${i}` },
        'Performance validation summary',
      );
    }
    const averageMs = (performance.now() - start) / iterations;
    expect(averageMs).toBeLessThanOrEqual(20);
  });

  it('records latency histograms across repeated dispatches', async () => {
    const client = new CpcsHttpClient({
      baseUrl: 'https://cpcs-perf.test',
      dispatcher: async (_org, payload) => ({
        status: 'accepted' as const,
        reference: payload.id,
      }),
    });

    const iterations = 25;
    for (let i = 0; i < iterations; i += 1) {
      await client.sendReferral(
        'org-perf',
        { ...BASE_REQUEST, id: `metric-${i}` },
        'Histogram capture summary',
      );
    }
    const histogramEntries = getHistogramRecords('integration.latency_ms').filter(
      (record) => record.attributes?.provider === 'cpcs',
    );
    expect(histogramEntries.length).toBeGreaterThan(0);
  });
});
