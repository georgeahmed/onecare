/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDataClientCache, getJson, postJson } from '../src/lib/dataClient';
import { getSessionCorrelationId } from '../src/lib/telemetry';

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
  vi.restoreAllMocks();
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
});
