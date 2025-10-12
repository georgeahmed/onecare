import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IcsHttpClient, IcsClientError } from '../src/adapters/ics.client';
import type { ResolvedConfig, IcsConfig } from '@onecare/config';
import type { IcsReferralRequest, IcsReferralAck } from '@onecare/events';
import { resetMetrics, getCounterRecords, getHistogramRecords, logger } from '@onecare/observability';

const baseReferral: IcsReferralRequest = {
  referralId: 'ref-1',
  patientId: 'patient-1',
  org: 'ORG1',
  reason: 'support',
};

function buildConfig(): ResolvedConfig {
  const ics: IcsConfig = {
    routes: {
      ORG1: {
        endpoint: 'https://ics.example/org1',
        apiKey: 'api-org1',
        headers: { 'X-Org': 'ORG1' },
        timeoutMs: 50,
        retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
        circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
        correlationHeader: 'x-corr',
        tls: { ca: 'CA', cert: 'CERT', key: 'KEY', rejectUnauthorized: true },
        rateLimitPerMinute: 10,
      },
    },
  };
  return { practiceId: 'demo', ics } as unknown as ResolvedConfig;
}

describe('IcsHttpClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetMetrics();
    vi.useRealTimers();
  });

  it('sends referral successfully with mapping and TLS context', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest, context) => {
      expect(context.headers.Authorization).toBe('Bearer token');
      expect(context.headers['x-correlation-id']).toBe('corr-123');
      expect(context.tls).toEqual({ ca: 'CA', cert: 'CERT', key: 'KEY', rejectUnauthorized: true });
      expect(context.operation).toBe('referral');
      expect(request.org).toBe('ORG1');
      return { referralId: request.referralId, accepted: true };
    });
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { 'X-Org': 'ORG1', Authorization: 'Bearer token' },
          timeoutMs: 200,
          retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
          circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
          tls: { ca: 'CA', cert: 'CERT', key: 'KEY', rejectUnauthorized: true },
          correlationHeader: 'x-correlation-id',
        },
      },
      referralDispatcher: dispatcher,
    });

    const ack = await client.sendReferral(baseReferral, { correlationId: 'corr-123' });

    expect(ack).toEqual({ referralId: 'ref-1', accepted: true });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const successCall = infoSpy.mock.calls.find(([msg]) => msg === 'integration.call.success');
    expect(successCall?.[1]).toMatchObject({
      provider: 'ics',
      operation: 'referral',
      endpoint: 'https://ics.example/org1',
      correlationId: 'corr-123',
    });
    const latencyRecords = getHistogramRecords('integration.latency_ms');
    expect(latencyRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ provider: 'ics', operation: 'referral', outcome: 'success' }),
        }),
      ]),
    );
  });

  it('acknowledges referral using same route', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const ackDispatcher = vi.fn(async (_route, refId: string, ack: IcsReferralAck, context) => {
      expect(context.operation).toBe('ack');
      expect(refId).toBe('ref-1');
      expect(context.headers.Authorization).toMatch(/^Bearer /);
      return ack;
    });
    const client = IcsHttpClient.fromConfig(buildConfig(), { ackDispatcher });
    const result = await client.acknowledge(
      'ref-1',
      { referralId: 'ref-1', accepted: true },
      { correlationId: 'corr', organisationIdOverride: 'ORG1' },
    );
    expect(result).toEqual({ referralId: 'ref-1', accepted: true });
    expect(ackDispatcher).toHaveBeenCalledTimes(1);
    const successCall = infoSpy.mock.calls.find(([msg]) => msg === 'integration.call.success');
    expect(successCall?.[1]).toMatchObject({ provider: 'ics', operation: 'ack' });
    const successRecords = getCounterRecords('integration.call.success_total');
    expect(successRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', operation: 'ack' }) }),
      ]),
    );
  });

  it('throws forbidden when organisation not configured', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = IcsHttpClient.fromConfig(buildConfig());
    await expect(
      client.sendReferral({ ...baseReferral, org: 'UNKNOWN' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const blockedCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.blocked');
    expect(blockedCall?.[1]).toMatchObject({ provider: 'ics', result: 'blocked', organisationId: 'unknown' });
    const blockedRecords = getCounterRecords('integration.call.blocked_total');
    expect(blockedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', organisationId: 'unknown' }) }),
      ]),
    );
  });

  it('retries on timeout and returns timeout error', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const dispatcher = vi.fn(async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { referralId: 'ref-1', accepted: true };
    });
    const client = IcsHttpClient.fromConfig(buildConfig(), {
      referralDispatcher: dispatcher,
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { Authorization: 'Bearer token' },
          timeoutMs: 40,
          retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
          circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
        },
      },
    });

    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({ code: 'upstream_timeout' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    const retryCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.retry');
    expect(retryCall?.[1]).toMatchObject({ provider: 'ics', operation: 'referral', code: 'upstream_timeout' });
    const timeoutRecords = getCounterRecords('integration.call.timeout_total');
    expect(timeoutRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', operation: 'referral' }) }),
      ]),
    );
  });

  it('maps 5xx errors to upstream_unavailable and does not retry beyond attempts', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => {
      const error = new Error('down') as Error & { status?: number };
      error.status = 503;
      throw error;
    });
    const client = IcsHttpClient.fromConfig(buildConfig(), {
      referralDispatcher: dispatcher,
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { Authorization: 'Bearer token' },
          timeoutMs: 100,
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
        },
      },
    });
    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const failureCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.failure');
    expect(failureCall?.[1]).toMatchObject({ provider: 'ics', operation: 'referral', code: 'upstream_unavailable' });
    const errorRecords = getCounterRecords('integration.call.error_total');
    expect(errorRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', operation: 'referral', code: 'upstream_unavailable' }) }),
      ]),
    );
  });

  it('opens circuit breaker after repeated failures', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => {
      throw new IcsClientError('upstream_unavailable', 'fail');
    });
    const client = IcsHttpClient.fromConfig(buildConfig(), {
      referralDispatcher: dispatcher,
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { Authorization: 'Bearer token' },
          timeoutMs: 100,
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 5_000 },
        },
      },
    });

    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'ICS circuit breaker open',
    });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    const circuitCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.circuit_open');
    expect(circuitCall?.[1]).toMatchObject({ provider: 'ics', operation: 'referral' });
    const circuitRecords = getCounterRecords('integration.call.circuit_open_total');
    expect(circuitRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', operation: 'referral' }) }),
      ]),
    );
  });

  it('enforces simple rate limit stub per organisation', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => ({ referralId: 'ref-1', accepted: true }));
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { Authorization: 'Bearer token' },
          timeoutMs: 100,
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000 },
          rateLimitPerMinute: 1,
        },
      },
      referralDispatcher: dispatcher,
    });

    await client.sendReferral(baseReferral);
    await expect(client.sendReferral(baseReferral)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const failureCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.failure');
    expect(failureCall?.[1]).toMatchObject({ provider: 'ics', operation: 'referral', code: 'rate_limited' });
    const errorRecords = getCounterRecords('integration.call.error_total');
    expect(errorRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'ics', operation: 'referral', code: 'rate_limited' }) }),
      ]),
    );
  });
});
