import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CpcsHttpClient, CpcsClientError, type CpcsServiceRequest, type CpcsSlot, type CpcsDispatchPayload } from '../src/adapters/cpcs.client';
import type { ResolvedConfig } from '@onecare/config';
import { resetMetrics, getHistogramRecords, getCounterRecords, logger } from '@onecare/observability';

const envBackup = { ...process.env };

describe('CpcsHttpClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
    process.env.CPCS_URL = 'https://cpcs.test/api';
    process.env.CPCS_API_KEY = 'demo-key';
    delete process.env.CPCS_HEADER_NAME;
    delete process.env.CPCS_HEADER_VALUE;
    delete process.env.CPCS_EXTRA_HEADERS;
    delete process.env.CPCS_TIMEOUT_MS;
    delete process.env.CPCS_SLOTLESS_FALLBACK_ENABLED;
    delete process.env.CPCS_SLOTLESS_FALLBACK;
    delete process.env.CPCS_CORRELATION_HEADER;
    resetMetrics();
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  const serviceRequest: CpcsServiceRequest = {
    id: 'sr-123',
    patientReference: 'patient-1',
    presentingComplaintCode: 'S76',
    consentTimestamp: '2025-10-12T11:00:00Z',
  };
  const summary = 'CPCS referral summary';

  it('creates client from env variables', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    process.env.CPCS_HEADER_NAME = 'X-Test';
    process.env.CPCS_HEADER_VALUE = 'value';
    const client = CpcsHttpClient.fromEnv();
    expect(client.getBaseUrl()).toBe('https://cpcs.test/api');
    expect(client.getHeaders()).toMatchObject({
      Authorization: 'Bearer demo-key',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Test': 'value',
    });
    const result = await client.sendReferral('org-1', serviceRequest, summary, undefined, { correlationId: 'corr-env' });
    expect(result.status).toBe('accepted');
    expect(result.reference).toBe('cpcs-sr-123');
    const successCall = infoSpy.mock.calls.find(([msg]) => msg === 'integration.call.success');
    expect(successCall?.[1]).toMatchObject({
      provider: 'cpcs',
      operation: 'slotless',
      endpoint: 'https://cpcs.test/api',
      correlationId: 'corr-env',
      result: 'success',
    });
    const latencyRecords = getHistogramRecords('integration.latency_ms');
    expect(latencyRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ provider: 'cpcs', operation: 'slotless', outcome: 'success' }),
        }),
      ]),
    );
    const successRecords = getCounterRecords('integration.call.success_total');
    expect(successRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'cpcs', operation: 'slotless' }) }),
      ]),
    );
  });

  it('accepts overrides and slot data', async () => {
    const dispatch = vi.fn(async (_org: string, payload: CpcsDispatchPayload, slot: CpcsSlot | undefined, context) => {
      expect(context?.headers['x-correlation-id']).toBe('corr-override');
      expect(context?.path).toBe(slot ? 'slot' : 'slotless');
      expect(context?.timeoutMs).toBe(100);
      expect(payload.summary).toBe(summary);
      expect(payload.id).toBe(serviceRequest.id);
      return {
        status: 'queued' as const,
        reference: slot?.reference ?? 'queued',
        code: 'DELAY',
      };
    });
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      headers: { 'X-Env': 'true' },
      dispatcher: dispatch,
      timeoutMs: 100,
    });
    const slot: CpcsSlot = {
      start: '2025-10-12T12:00:00Z',
      end: '2025-10-12T12:15:00Z',
      locationOdsCode: 'ODS1',
      reference: 'slot-1',
    };
    const response = await client.sendReferral('org-1', serviceRequest, summary, slot, { correlationId: 'corr-override' });
    expect(response).toEqual({ status: 'queued', reference: 'slot-1', code: 'DELAY' });
    expect(dispatch).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ id: serviceRequest.id, summary }),
      slot,
      expect.objectContaining({
        correlationId: 'corr-override',
        path: 'slot',
      }),
    );
  });

  it('creates client from resolved config', () => {
    const config = {
      practiceId: 'demo',
      cpcs: {
        endpoint: 'https://config.test',
        apiKey: 'cfg-key',
        headers: { 'X-Config': 'yes' },
      },
    } as ResolvedConfig;
    const client = CpcsHttpClient.fromConfig(config);
    expect(client.getBaseUrl()).toBe('https://config.test');
    expect(client.getHeaders()).toMatchObject({
      Authorization: 'Bearer cfg-key',
      'X-Config': 'yes',
    });
  });

  it('rejects non-https base urls', () => {
    expect(() => new CpcsHttpClient({ baseUrl: 'http://cpcs.internal' })).toThrow('cpcs_base_url_insecure');
  });

  it('rejects loopback or private endpoints', () => {
    expect(() => new CpcsHttpClient({ baseUrl: 'https://127.0.0.1' })).toThrow('cpcs_base_url_blocked');
    expect(() => new CpcsHttpClient({ baseUrl: 'https://10.0.0.5' })).toThrow('cpcs_base_url_blocked');
  });

  it('normalises base url paths', () => {
    const client = new CpcsHttpClient({ baseUrl: 'https://cpcs.test/api/v1/' });
    expect(client.getBaseUrl()).toBe('https://cpcs.test/api/v1');
  });

  it('throws typed error on invalid arguments', async () => {
    const client = CpcsHttpClient.fromEnv();
    await expect(client.sendReferral('', serviceRequest, summary)).rejects.toThrow(CpcsClientError);
    await expect(
      client.sendReferral('org-1', { ...serviceRequest, id: '' }, summary),
    ).rejects.toThrow('ServiceRequest identifier is required');
    await expect(
      client.sendReferral('org-1', serviceRequest, ''),
    ).rejects.toThrow('Referral summary is required');
  });

  it('wraps dispatcher errors', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      dispatcher: vi.fn(async () => {
        throw new Error('boom');
      }),
      retry: { attempts: 0 },
    });
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toThrow('CPCS referral request failed');
    const failureCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.failure');
    expect(failureCall?.[1]).toMatchObject({ provider: 'cpcs', operation: 'slotless', code: 'internal_error' });
  });

  it('retries on timeout and surfaces timeout error', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: 'accepted' as const, reference: 'slow' };
    });
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      dispatcher,
      timeoutMs: 40,
      retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
    });
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toMatchObject({ code: 'upstream_timeout' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    const retryCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.retry');
    expect(retryCall?.[1]).toMatchObject({ provider: 'cpcs', operation: 'slotless', code: 'upstream_timeout' });
    const timeoutRecords = getCounterRecords('integration.call.timeout_total');
    expect(timeoutRecords).toHaveLength(1);
    expect(timeoutRecords[0].attributes).toMatchObject({ provider: 'cpcs', operation: 'slotless' });
  });

  it('maps 5xx errors to upstream_unavailable', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => {
      const err = new Error('maintenance') as Error & { status?: number };
      err.status = 503;
      throw err;
    });
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      dispatcher,
      retry: { attempts: 0 },
    });
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const failureCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.failure');
    expect(failureCall?.[1]).toMatchObject({ provider: 'cpcs', operation: 'slotless', code: 'upstream_unavailable' });
    const errorRecords = getCounterRecords('integration.call.error_total');
    expect(errorRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'cpcs', operation: 'slotless', code: 'upstream_unavailable' }) }),
      ]),
    );
  });

  it('opens circuit breaker after repeated failures', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const dispatcher = vi.fn(async () => {
      throw new CpcsClientError('upstream_unavailable', 'fail');
    });
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      dispatcher,
      retry: { attempts: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
    });
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    await expect(client.sendReferral('org-1', serviceRequest, summary)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'CPCS circuit breaker open',
    });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    const circuitCall = warnSpy.mock.calls.find(([msg]) => msg === 'integration.call.circuit_open');
    expect(circuitCall?.[1]).toMatchObject({ provider: 'cpcs', operation: 'slotless' });
    const circuitRecords = getCounterRecords('integration.call.circuit_open_total');
    expect(circuitRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ provider: 'cpcs', operation: 'slotless' }) }),
      ]),
    );
  });

  it('falls back to slotless referral when slots unavailable', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const dispatcher = vi
      .fn()
      .mockImplementationOnce(async (_org, _payload, slot, context) => {
        expect(context?.path).toBe('slot');
        expect(slot).toBeDefined();
        return { status: 'rejected' as const, reference: 'slot-1', code: 'slot_unavailable' };
      })
      .mockImplementationOnce(async (_org, _payload, slot, context) => {
        expect(context?.path).toBe('slotless');
        expect(slot).toBeUndefined();
        return { status: 'accepted' as const, reference: 'slotless-ref' };
      });
    const client = new CpcsHttpClient({
      baseUrl: 'https://override.test',
      dispatcher,
      slotlessFallbackEnabled: true,
    });
    const slot: CpcsSlot = {
      start: '2025-10-12T12:00:00Z',
      end: '2025-10-12T12:15:00Z',
      locationOdsCode: 'ODS1',
      reference: 'slot-1',
    };
    const result = await client.sendReferral('org-1', serviceRequest, summary, slot, { correlationId: 'corr-fallback' });
    expect(result).toEqual({ status: 'accepted', reference: 'slotless-ref' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
    const fallbackLog = infoSpy.mock.calls.find(([msg]) => msg === 'integration.call.fallback');
    expect(fallbackLog?.[1]).toMatchObject({ provider: 'cpcs', operation: 'slot', fallback: 'slotless' });
  });
});
