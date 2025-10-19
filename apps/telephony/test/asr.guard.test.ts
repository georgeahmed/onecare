import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HttpAsrClient,
  AsrClientError,
  StubAsrClient,
  createAsrClientFromEnv,
  __resetAsrCircuitBreakers,
} from '../src/adapters/asr.client';
import { resetMetrics, getCounterRecords, setCorrelationId } from '@onecare/observability';

describe('HttpAsrClient guardrails', () => {
  beforeEach(() => {
    resetMetrics();
    setCorrelationId(undefined);
    __resetAsrCircuitBreakers();
  });

  it('retries on transient failures and returns sanitized transcript', async () => {
    setCorrelationId('corr-123');
    let attempt = 0;
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      const currentAttempt = attempt;
      attempt += 1;
      expect(init?.redirect).toBe('manual');
      if (currentAttempt === 0) {
        return new Response(JSON.stringify({ error: 'upstream' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers).toMatchObject({
        'content-type': 'application/json',
        'x-correlation-id': 'corr-123',
      });
      if (headers.traceparent) {
        expect(typeof headers.traceparent).toBe('string');
      }
      return new Response(
        JSON.stringify({
          text: '  ready  ',
          lang: 'en-GB',
          diarization: [
            { speaker: 'spk1', startMs: 0, endMs: 1500 },
            { speaker: 'speaker-b', start: 1.5, end: 3 },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const client = new HttpAsrClient({
      endpoint: 'https://asr.example.com/v1/transcribe',
      hostAllowlist: ['asr.example.com'],
      fetchImpl,
      timeoutMs: 500,
      baseDelayMs: 1,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 1000,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
    });

    const result = await client.transcribe('call-123', 'memory://call-123');
    expect(result.text).toBe('ready');
    expect(result.lang).toBe('en-GB');
    expect(result.diarization).toEqual([
      { speaker: 'spk1', startMs: 0, endMs: 1500 },
      { speaker: 'speaker-b', startMs: 1500, endMs: 3000 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getCounterRecords('asr.retry')).toHaveLength(1);
    expect(getCounterRecords('asr.timeout')).toHaveLength(0);
  });

  it('counts timeouts and surfaces timeout errors', async () => {
    const fetchImpl = vi.fn((_url, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
          reject(abortError);
        });
      });
    });

    const client = new HttpAsrClient({
      endpoint: 'https://asr.example.com/v1/transcribe',
      hostAllowlist: ['asr.example.com'],
      fetchImpl,
      timeoutMs: 50,
      baseDelayMs: 1,
      circuitBreakerFailureThreshold: 2,
      circuitBreakerCooldownMs: 500,
      maxRetries: 0,
      sleep: () => Promise.resolve(),
      random: () => 0.1,
    });

    await expect(client.transcribe('call-1', 'memory://call-1')).rejects.toMatchObject({
      code: 'asr_timeout',
    });
    expect(getCounterRecords('asr.timeout')).toHaveLength(1);
  });

  it('opens the circuit after repeated failures', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpAsrClient({
      endpoint: 'https://asr.example.com/v1/transcribe',
      hostAllowlist: ['asr.example.com'],
      fetchImpl,
      timeoutMs: 200,
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerCooldownMs: 10_000,
      sleep: () => Promise.resolve(),
      random: () => 0.1,
    });

    await expect(client.transcribe('call-1', 'memory://call-1')).rejects.toBeInstanceOf(AsrClientError);
    expect(getCounterRecords('asr.cb.open')).toHaveLength(1);
    await expect(client.transcribe('call-2', 'memory://call-2')).rejects.toMatchObject({
      code: 'asr_circuit_open',
    });
  });

  it('rejects insecure or private endpoints', () => {
    expect(
      () =>
        new HttpAsrClient({
          endpoint: 'https://127.0.0.1:9000/transcribe',
          hostAllowlist: ['127.0.0.1'],
        }),
    ).toThrowError('telephony_asr_endpoint_private');

    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(
      () =>
        new HttpAsrClient({
          endpoint: 'http://asr.example.com/transcribe',
          hostAllowlist: ['asr.example.com'],
        }),
    ).toThrowError('telephony_asr_endpoint_insecure');
    process.env.NODE_ENV = previousEnv;
  });

  it('falls back to stub client when env vars missing', () => {
    const existing = process.env.TELEPHONY_ASR_ENDPOINT;
    delete process.env.TELEPHONY_ASR_ENDPOINT;
    const client = createAsrClientFromEnv();
    expect(client).toBeInstanceOf(StubAsrClient);
    if (existing) {
      process.env.TELEPHONY_ASR_ENDPOINT = existing;
    }
  });
});
