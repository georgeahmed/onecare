import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setCorrelationId, resetMetrics, getHistogramRecords, getCounterRecords } from '@onecare/observability';
import type { FhirBundle } from '@onecare/ports';
import { HttpFhirRepository, isFhirRequestError } from './fhir.repository';

const BASE_URL = 'https://fhir.example.org';

const jsonResponse = (body: unknown, init?: { status?: number }): Response =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/fhir+json; charset=utf-8' },
  });

describe('HttpFhirRepository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetMetrics();
    setCorrelationId(undefined);
  });

  afterEach(() => {
    setCorrelationId(undefined);
  });

  it('posts bundle payload with auth and correlation headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'bundle-1' }));
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      authToken: 'token-123',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    setCorrelationId('corr-123');

    const bundle: FhirBundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const result = await repo.upsertBundle(bundle);

    expect(result).toMatchObject({ id: 'bundle-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://fhir.example.org/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      accept: 'application/fhir+json; charset=utf-8',
      authorization: 'Bearer token-123',
      prefer: 'return=representation',
      'content-type': 'application/fhir+json; charset=utf-8',
      'x-correlation-id': 'corr-123',
    });
    expect(init?.body).toBe(JSON.stringify(bundle));
  });

  it('retries transient errors and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'Task/1', resourceType: 'Task' }, { status: 201 }));

    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
    });

    const task = { resourceType: 'Task', status: 'requested' };
    const created = await repo.createTask(task);

    expect(created).toMatchObject({ id: 'Task/1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws FhirRequestError on non-retryable status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issue: [{ details: { text: 'bad payload' } }] }), { status: 400 }),
    );

    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(repo.createAppointment({ resourceType: 'Appointment' })).rejects.toSatisfy((err) => {
      expect(isFhirRequestError(err)).toBe(true);
      if (isFhirRequestError(err)) {
        expect(err.status).toBe(400);
      }
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records metrics for requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'doc-1' }, { status: 201 }));
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      practiceId: 'demo-practice',
    });

    await repo.createDocumentReference({ resourceType: 'DocumentReference' });

    const latencyRecords = getHistogramRecords('fhir_request_latency_ms');
    expect(latencyRecords.length).toBeGreaterThan(0);
    expect(latencyRecords[0]?.attributes).toMatchObject({
      path: 'DocumentReference',
      practiceId: 'demo-practice',
    });

    const counters = getCounterRecords('fhir_requests_total');
    expect(counters.length).toBe(1);
    expect(counters[0]?.attributes).toMatchObject({ status: 201 });
  });

  it('rejects responses with unexpected content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resourceType: 'Task', id: 'Task/1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(repo.createTask({ resourceType: 'Task' })).rejects.toSatisfy((err) => {
      expect(isFhirRequestError(err)).toBe(true);
      if (isFhirRequestError(err)) {
        expect(err.message).toMatch(/unexpected_content_type/i);
        expect(err.retryable).toBe(false);
      }
      return true;
    });
  });

  it('reads resources with query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ resourceType: 'Task', id: 'Task/1' }));
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await repo.readResource('Task/1', {
      searchParams: { _format: 'json', summary: true },
      prefer: 'return=minimal',
      headers: { 'if-none-match': 'W/"etag"' },
    });

    expect(result).toMatchObject({ resourceType: 'Task', id: 'Task/1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://fhir.example.org/Task/1?_format=json&summary=true');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({
      accept: 'application/fhir+json; charset=utf-8',
      prefer: 'return=minimal',
      'if-none-match': 'W/"etag"',
    });
  });

  it('opens the circuit after repeated upstream failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 60_000,
    });

    await expect(repo.createTask({ resourceType: 'Task' })).rejects.toBeInstanceOf(Error);
    await expect(repo.createTask({ resourceType: 'Task' })).rejects.toBeInstanceOf(Error);
    await expect(repo.createTask({ resourceType: 'Task' })).rejects.toSatisfy((err) => {
      expect(isFhirRequestError(err)).toBe(true);
      if (isFhirRequestError(err)) {
        expect(err.message).toBe('circuit_open');
        expect(err.retryable).toBe(false);
      }
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for Retry-After before retrying transient errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('service unavailable', {
          status: 503,
          headers: { 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'Task/99', resourceType: 'Task' }, { status: 200 }));

    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
    });

    const promise = repo.createTask({ resourceType: 'Task' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ id: 'Task/99' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('treats conflicts on idempotent operations without tripping the circuit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issue: [{ diagnostics: 'duplicate' }] }), { status: 409 }),
    );
    const repo = new HttpFhirRepository({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(repo.upsertBundle({ resourceType: 'Bundle', type: 'transaction', entry: [] })).rejects.toSatisfy(
      (err) => {
        expect(isFhirRequestError(err)).toBe(true);
        if (isFhirRequestError(err)) {
          expect(err.status).toBe(409);
        }
        return true;
      },
    );

    await expect(repo.upsertBundle({ resourceType: 'Bundle', type: 'transaction', entry: [] })).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
