import { describe, it, expect, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { IcsHttpClient } from '../src/adapters/ics.client';
import type { IcsReferralRequest, IcsReferralAck } from '@onecare/events';
import { resetMetrics, getHistogramRecords } from '@onecare/observability';

const BASE_REFERRAL: IcsReferralRequest = {
  referralId: 'ref-0',
  patientId: 'patient-0',
  org: 'ORG1',
  reason: 'support',
};

const BASE_ACK: IcsReferralAck = {
  referralId: 'ref-0',
  accepted: true,
};

describe('IcsHttpClient performance baselines', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('routes referrals within 20ms average budget', async () => {
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics-perf.test/org1',
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: async (_route, request) => ({ referralId: request.referralId, accepted: true }),
    });

    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await client.sendReferral({ ...BASE_REFERRAL, referralId: `ref-${i}` });
    }
    const averageMs = (performance.now() - start) / iterations;
    expect(averageMs).toBeLessThanOrEqual(20);
  });

  it('acknowledges referrals within 15ms average budget', async () => {
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics-perf.test/org1',
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: async (_route, request) => ({ referralId: request.referralId, accepted: true }),
      ackDispatcher: async (_route, referralId, ack) => ({ ...ack, referralId }),
    });

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const id = `ack-${i}`;
      await client.acknowledge(id, { ...BASE_ACK, referralId: id }, { organisationIdOverride: 'ORG1' });
    }
    const averageMs = (performance.now() - start) / iterations;
    expect(averageMs).toBeLessThanOrEqual(15);
  });

  it('records integration latency metrics for ICS flows', async () => {
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics-perf.test/org1',
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: async (_route, request) => ({ referralId: request.referralId, accepted: true }),
    });

    for (let i = 0; i < 25; i += 1) {
      await client.sendReferral({ ...BASE_REFERRAL, referralId: `metric-${i}` });
    }

    const histogramEntries = getHistogramRecords('integration.latency_ms').filter(
      (record) => record.attributes?.provider === 'ics',
    );
    expect(histogramEntries.length).toBeGreaterThan(0);
  });
});
