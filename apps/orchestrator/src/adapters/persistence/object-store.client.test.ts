import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCorrelationId, resetMetrics, getCounterRecords } from '@onecare/observability';
import { HttpObjectStore } from './object-store.client';

const BASE_URL = 'https://object.example/store/';

describe('HttpObjectStore', () => {
  beforeEach(() => {
    resetMetrics();
    setCorrelationId(undefined);
  });

  it('uploads objects with correlation and content headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const store = new HttpObjectStore({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock,
    });
    setCorrelationId('corr-obj');
    const body = Buffer.from('hello');

    const result = await store.put('docs/doc-1', body, 'text/plain');

    expect(result.url).toBe('https://object.example/store/docs/doc-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://object.example/store/docs/doc-1');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({
      'content-type': 'text/plain',
      'x-correlation-id': 'corr-obj',
    });
    expect(init?.body).toBeInstanceOf(Uint8Array);
  });

  it('retrieves objects as Uint8Array', async () => {
    const payload = Buffer.from('payload');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const store = new HttpObjectStore({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock,
    });

    const result = await store.get('docs/doc-2');

    expect(Buffer.from(result).toString('utf8')).toBe('payload');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://object.example/store/docs/doc-2');
    expect(init?.method).toBe('GET');
  });

  it('records metrics for requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const store = new HttpObjectStore({
      baseUrl: BASE_URL,
      fetchImpl: fetchMock,
    });

    await store.put('docs/doc-3', Buffer.from('hello'), 'text/plain');

    const counters = getCounterRecords('object_store_requests_total');
    expect(counters.length).toBeGreaterThan(0);
    expect(counters[0]?.attributes).toMatchObject({ method: 'PUT' });
  });
});
