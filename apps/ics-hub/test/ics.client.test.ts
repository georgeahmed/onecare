vi.mock('@onecare/observability', async () => {
  const actual = await vi.importActual<typeof import('@onecare/observability')>('@onecare/observability');
  const spanStub = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    end: vi.fn(),
    isRecording: () => true,
  };
  return {
    ...actual,
    startSpan: vi.fn(() => spanStub),
    __spanStub: spanStub,
  };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IcsHttpClient, IcsClientError } from '../src/adapters/ics.client';
import type { ResolvedConfig, IcsConfig } from '@onecare/config';
import type { IcsReferralRequest, IcsReferralAck } from '@onecare/events';
import * as observability from '@onecare/observability';

type SpanStub = {
  setAttribute: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  addEvent: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  isRecording: () => boolean;
};

const {
  resetMetrics,
  getCounterRecords,
  getHistogramRecords,
  logger,
  startSpan,
  __spanStub: spanStub,
} = observability as typeof observability & { __spanStub: SpanStub };

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
    vi.clearAllMocks();
    resetMetrics();
    vi.useRealTimers();
    startSpan.mockClear();
    spanStub.setAttribute.mockClear();
    spanStub.setStatus.mockClear();
    spanStub.recordException.mockClear();
    spanStub.addEvent.mockClear();
    spanStub.end.mockClear();
  });

  it('sends referral successfully with mapping and TLS context', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest, context) => {
      expect(context.headers.Authorization).toBe('Bearer token');
      expect(context.headers['x-correlation-id']).toBe('corr-123');
      expect(context.headers.Accept).toBe('application/json');
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

  it('enforces https endpoints and blocks private hosts', () => {
    expect(() => new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'http://ics.example.org',
        },
      },
    })).toThrow('ics_endpoint_insecure');

    expect(() => new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://127.0.0.1/service',
        },
      },
    })).toThrow('ics_endpoint_blocked');
  });

  it('normalises endpoint path by trimming trailing slash', async () => {
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest, context) => {
      expect(context.endpoint).toBe('https://ics.example/org1');
      expect(context.headers.Accept).toBe('application/json');
      return { referralId: request.referralId, accepted: true };
    });
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1/',
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: dispatcher,
    });

    await client.sendReferral(baseReferral);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes route credentials and TLS without rebuilding client', async () => {
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest, context) => ({
      referralId: request.referralId,
      accepted: true,
      headers: context.headers,
      tls: context.tls,
    }));
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: { 'X-Org': 'ORG1', Authorization: 'Bearer initial' },
          tls: { ca: 'CA1', cert: 'CERT1', key: 'KEY1', rejectUnauthorized: true },
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: dispatcher,
    });

    await client.sendReferral(baseReferral, { correlationId: 'corr-initial' });
    dispatcher.mockClear();

    client.refreshRouteCredentials('ORG1', {
      headers: { 'X-Org': 'ORG1', 'X-Env': 'rotated' },
      apiKey: 'rotated-token',
      correlationHeader: 'x-rot-corr',
      tls: { ca: 'CA2', cert: 'CERT2', key: 'KEY2', rejectUnauthorized: true },
    });

    await client.sendReferral(baseReferral, { correlationId: 'corr-rotated' });
    const [, , context] = dispatcher.mock.calls.at(-1)!;
    expect(context.headers.Authorization).toBe('Bearer rotated-token');
    expect(context.headers['X-Env']).toBe('rotated');
    expect(context.headers.Accept).toBe('application/json');
    expect(context.headers['x-rot-corr']).toBe('corr-rotated');
    expect(context.tls).toEqual({ ca: 'CA2', cert: 'CERT2', key: 'KEY2', rejectUnauthorized: true });
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

  it('requires organisation override when no default route is configured for ack', async () => {
    const client = IcsHttpClient.fromConfig(buildConfig());
    await expect(
      client.acknowledge('ref-1', { referralId: 'ref-1', accepted: true }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('falls back to default route for ack when override absent', async () => {
    const ackDispatcher = vi.fn(async (route, refId: string, ack: IcsReferralAck) => {
      expect(route.key).toBe('default');
      expect(refId).toBe('ref-1');
      return ack;
    });
    const client = new IcsHttpClient({
      routes: {},
      defaultRoute: {
        endpoint: 'https://ics.example/default',
        headers: { Authorization: 'Bearer token' },
        timeoutMs: 100,
        retry: { attempts: 0 },
        circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
      },
      ackDispatcher,
    });

    const result = await client.acknowledge('ref-1', { referralId: 'ref-1', accepted: true });
    expect(result).toEqual({ referralId: 'ref-1', accepted: true });
    expect(ackDispatcher).toHaveBeenCalledTimes(1);
  });

  it('defaults correlation header when config provides blank value', async () => {
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest, context) => {
      expect(context.headers['x-correlation-id']).toBe('corr-blank');
      expect(Object.keys(context.headers)).not.toContain('');
      return { referralId: request.referralId, accepted: true };
    });
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: {},
          timeoutMs: 100,
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
          correlationHeader: '   ',
        },
      },
      referralDispatcher: dispatcher,
    });

    await client.sendReferral(baseReferral, { correlationId: 'corr-blank' });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('retries when provider responds with rate limit status', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const dispatcher = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error: any = new Error('429');
        error.response = { status: 429 };
        throw error;
      }
      return { referralId: 'ref-1', accepted: true };
    });
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
          headers: {},
          timeoutMs: 200,
          retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
        },
      },
      referralDispatcher: dispatcher,
    });

    const ack = await client.sendReferral(baseReferral);
    expect(ack).toEqual({ referralId: 'ref-1', accepted: true });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.some(([msg]) => msg === 'integration.call.retry')).toBe(true);
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
    expect(attempts).toBe(2);
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

  it('supports default-only configuration when explicit routes absent', async () => {
    const dispatcher = vi.fn(async (route, request: IcsReferralRequest, context) => {
      expect(route.key).toBe('default');
      expect(context.endpoint).toBe('https://ics.example/default');
      return { referralId: request.referralId, accepted: true };
    });
    const client = new IcsHttpClient({
      routes: {},
      defaultRoute: {
        endpoint: 'https://ics.example/default',
        headers: { Authorization: 'Bearer token' },
        timeoutMs: 100,
        retry: { attempts: 0 },
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
        correlationHeader: 'x-cid',
      },
      referralDispatcher: dispatcher,
    });

    const ack = await client.sendReferral({ ...baseReferral, org: 'NEW' }, { correlationId: 'cid-1' });

    expect(ack).toEqual({ referralId: 'ref-1', accepted: true });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('builds from config with only default route defined', async () => {
    const dispatcher = vi.fn(async (_route, request: IcsReferralRequest) => ({
      referralId: request.referralId,
      accepted: true,
    }));
    const config = {
      practiceId: 'demo',
      ics: {
        default: {
          endpoint: 'https://ics.example/default',
          apiKey: 'secret',
          timeoutMs: 100,
          retry: { attempts: 0 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 500 },
        },
      },
    } as unknown as ResolvedConfig;

    const client = IcsHttpClient.fromConfig(config, { referralDispatcher: dispatcher });
    const ack = await client.sendReferral({ ...baseReferral, org: 'unknown' });

    expect(ack).toEqual({ referralId: 'ref-1', accepted: true });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('records organisation id attribute on spans', async () => {
    const dispatcher = vi.fn(async () => ({ referralId: 'ref-1', accepted: true }));
    const client = new IcsHttpClient({
      routes: {
        ORG1: {
          endpoint: 'https://ics.example/org1',
        },
      },
      referralDispatcher: dispatcher,
    });

    await client.sendReferral({ ...baseReferral, org: 'ORG1' });

    expect(startSpan).toHaveBeenCalled();
    expect(spanStub.setAttribute).toHaveBeenCalledWith('integration.organisation_id', 'org1');
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
