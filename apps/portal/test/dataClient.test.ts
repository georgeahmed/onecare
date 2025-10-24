/// <reference types="vitest/globals" />

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/telemetry', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/telemetry')>('../src/lib/telemetry');
  return {
    ...actual,
    recordRumEvent: vi.fn(),
    safeLog: vi.fn()
  };
});

import { clearDataClientCache, getJson, postJson } from '../src/lib/dataClient';
import { getSessionCorrelationId, recordRumEvent, safeLog } from '../src/lib/telemetry';

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });

declare global {
  // eslint-disable-next-line no-var
  var fetch: typeof globalThis.fetch;
}

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  const storage: Record<string, string> = {};
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete storage[key];
    })
  };

  const dispatchEventMock = vi.fn();

  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: localStorageMock,
      dispatchEvent: dispatchEventMock
    },
    configurable: true
  });

  Object.defineProperty(globalThis, 'CustomEvent', {
    value: class CustomEvent<T> extends Event {
      detail: T;
      constructor(name: string, params?: CustomEventInit<T>) {
        super(name, params);
        this.detail = params?.detail as T;
      }
    },
    configurable: true
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  clearDataClientCache();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dataClient', () => {
  it('caches GET responses when ttl provided', async () => {
    const response = createResponse([{ id: 1 }]);
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(response);

    const result1 = await getJson('resource', { baseUrl: 'https://api.demo/', cacheTtlMs: 1_000 });
    const result2 = await getJson('resource', { baseUrl: 'https://api.demo/', cacheTtlMs: 1_000 });

    expect(result1).toEqual([{ id: 1 }]);
    expect(result2).toEqual([{ id: 1 }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('includes session correlation header on POST', async () => {
    const correlation = getSessionCorrelationId();
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(createResponse({ ok: true }));

    await postJson('items', {
      baseUrl: 'https://api.demo/',
      body: { foo: 'bar' }
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (globalThis.fetch as unknown as vi.Mock).mock.calls[0];
    expect((init as RequestInit)?.headers).toMatchObject({
      'x-session-correlation-id': correlation,
      'content-type': 'application/json'
    });
  });

  it('returns undefined for 204 responses', async () => {
    const response = new Response(null, { status: 204 });
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(response);

    const result = await getJson('empty', { baseUrl: 'https://api.demo/' });

    expect(result).toBeUndefined();
  });

  it('preserves sensitive header values while trimming whitespace', async () => {
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(createResponse({ ok: true }));

    await postJson('secure', {
      baseUrl: 'https://api.demo/',
      headers: {
        Authorization: '  Bearer super-secret-token  ',
        'x-api-key': undefined
      }
    });

    const [, init] = (globalThis.fetch as unknown as vi.Mock).mock.calls[0];
    expect((init as RequestInit)?.headers).toMatchObject({
      Authorization: 'Bearer super-secret-token'
    });
    expect(((init as RequestInit)?.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('keeps caller provided content-type and removes generated duplicates', async () => {
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(createResponse({ ok: true }));

    await postJson('merge', {
      baseUrl: 'https://api.demo/',
      body: { foo: 'bar' },
      headers: { 'Content-Type': 'application/merge-patch+json' }
    });

    const [, init] = (globalThis.fetch as unknown as vi.Mock).mock.calls[0];
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    const contentTypeKeys = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-type');
    expect(contentTypeKeys).toEqual(['Content-Type']);
    expect(headers['Content-Type']).toBe('application/merge-patch+json');
  });

  it('sends URLSearchParams bodies without forcing JSON serialization', async () => {
    (globalThis.fetch as unknown as vi.Mock).mockResolvedValue(createResponse({ ok: true }));

    const params = new URLSearchParams({ foo: 'bar' });
    await postJson('form', {
      baseUrl: 'https://api.demo/',
      body: params
    });

    const [, init] = (globalThis.fetch as unknown as vi.Mock).mock.calls[0];
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('content-type');
    expect((init as RequestInit)?.body).toBe(params);
  });

  it('emits telemetry when requests ultimately fail', async () => {
    (globalThis.fetch as unknown as vi.Mock).mockRejectedValue(new TypeError('network down'));

    await expect(getJson('resource', { baseUrl: 'https://api.demo/' })).rejects.toThrow('network down');
    expect(recordRumEvent).toHaveBeenCalledWith(
      'network.request.failure',
      expect.objectContaining({
        method: 'GET',
        path: 'resource',
        attemptCount: 1,
        error: 'network down'
      })
    );
    expect(safeLog).toHaveBeenCalledWith('dataClient.request.failed', expect.objectContaining({ path: 'resource' }));
  });
});
