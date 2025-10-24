import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { PortalSubmission, SafetyDecision } from '../src/lib/types';

const correlationSequence = [
  'corr-attempt-1',
  'req-attempt-1',
  'corr-attempt-2',
  'req-attempt-2',
  'corr-attempt-3',
  'req-attempt-3'
];

vi.mock('../src/lib/telemetry', () => {
  return {
    createCorrelationId: vi.fn(() => correlationSequence.shift() ?? 'corr-fallback'),
    getSessionCorrelationId: vi.fn(() => 'sess-correlation'),
    recordRumEvent: vi.fn(),
    safeLog: vi.fn()
  };
});

const payload: PortalSubmission = {
  practiceId: 'practice-123',
  patient: { id: 'patient-123' },
  narrative: 'Patient reports dizziness.',
  channel: 'web',
};

const buildResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });

describe('submitIntake', () => {
  beforeEach(() => {
    correlationSequence.splice(0, correlationSequence.length,
      'corr-attempt-1',
      'req-attempt-1',
      'corr-attempt-2',
      'req-attempt-2',
      'corr-attempt-3',
      'req-attempt-3'
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts payload and returns decision when request succeeds', async () => {
    const decision: SafetyDecision = { outcome: 'SAFE_TO_CONTINUE' };
    const fetchMock = vi.fn(() =>
      Promise.resolve(buildResponse(200, decision, { 'x-correlation-id': 'cid-success' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { submitIntake } = await import('../src/lib/api');
    const result = await submitIntake(payload, { baseUrl: 'https://orch.local' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-correlation-id': 'corr-attempt-1',
      'x-request-id': 'req-attempt-1',
      'x-session-correlation-id': 'sess-correlation'
    });
    expect(init?.credentials).toBe('include');
    expect(result.decision).toEqual(decision);
    expect(result.correlationId).toBe('cid-success');
  });

  it('retries on retryable status codes and notifies callback', async () => {
    vi.useFakeTimers();
    const decision: SafetyDecision = { outcome: 'DIVERTED', reason: 'unsafe' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse(503, { error: { code: 'busy' } }, { 'x-correlation-id': 'cid-retry' }))
      .mockResolvedValueOnce(buildResponse(200, decision, { 'x-correlation-id': 'cid-final' }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    const { submitIntake } = await import('../src/lib/api');
    const promise = submitIntake(payload, {
      retry: { maxRetries: 2, baseDelayMs: 100, jitter: false },
      onRetry,
      baseUrl: 'https://orch.local',
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, maxRetries: 2, correlationId: 'corr-attempt-1' });
    expect(result.correlationId).toBe('cid-final');
    expect(result.decision).toEqual(decision);
  });

  it('sends locale header and preserves base path segments', async () => {
    const decision: SafetyDecision = { outcome: 'SAFE_TO_CONTINUE' };
    const fetchMock = vi.fn(() =>
      Promise.resolve(buildResponse(200, decision, { 'x-correlation-id': 'cid-locale' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { submitIntake } = await import('../src/lib/api');
    await submitIntake(payload, { baseUrl: 'https://orch.local/api', locale: 'es' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(requestUrl).toBe('https://orch.local/api/safety-check');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-correlation-id': 'corr-attempt-1',
      'x-request-id': 'req-attempt-1',
      'x-session-correlation-id': 'sess-correlation',
      'accept-language': 'es',
    });
  });

  it('throws enriched error envelope when non-retryable response returned', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('failure', {
          status: 500,
        headers: { 'x-correlation-id': 'cid-fail' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { submitIntake } = await import('../src/lib/api');
    await expect(submitIntake(payload, { baseUrl: 'https://orch.local' })).rejects.toMatchObject({
      envelope: {
        error: {
          code: 'internal_error',
          message: 'Request failed with status 500',
          correlationId: 'cid-fail',
        },
      },
    });
  });

  it('aborts the request when timeout elapses', async () => {
    vi.useFakeTimers();
    const abortingFetch = vi.fn((_url: RequestInfo, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted');
          (error as Error).name = 'AbortError';
          reject(error);
        });
      });
    });
    vi.stubGlobal('fetch', abortingFetch);

    const { submitIntake } = await import('../src/lib/api');
    const request = submitIntake(payload, { baseUrl: 'https://orch.local', timeoutMs: 500 });
    const handled = request.catch((error) => error);

    await vi.advanceTimersByTimeAsync(500);
    const error = await handled;

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      envelope: {
        error: {
          code: 'upstream_timeout',
          correlationId: 'corr-attempt-1',
        },
      },
    });
    expect(abortingFetch).toHaveBeenCalledTimes(1);
  });

  it('treats external cancellations distinctly from timeouts', async () => {
    vi.useFakeTimers();
    const abortingFetch = vi.fn((_url: RequestInfo, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted');
          (error as Error).name = 'AbortError';
          reject(error);
        });
      });
    });
    vi.stubGlobal('fetch', abortingFetch);

    const { submitIntake } = await import('../src/lib/api');
    const controller = new AbortController();
    const request = submitIntake(payload, { baseUrl: 'https://orch.local', signal: controller.signal });
    const handled = request.catch((error) => error);

    controller.abort();
    await vi.runAllTimersAsync();
    const error = await handled;

    expect(error).toBeInstanceOf(Error);
    expect((error as { __clientCancelled?: boolean }).__clientCancelled).toBe(true);
  });
});
