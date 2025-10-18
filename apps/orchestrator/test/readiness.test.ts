import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
let originalFetch: typeof fetch;

function baseUrl(): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server not listening');
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

describe('orchestrator readiness endpoints', () => {
  beforeAll(async () => {
    process.env.BUS_IMPL = 'memory';
    const mod = await import('../src/index');
    server = mod.server;
    setBusReadyForTest = mod.setBusReadyForTest;
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (typeof url === 'string' && url.includes('/fhir/metadata')) {
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return originalFetch(input as RequestInfo, init as RequestInit);
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it('reports ready when the bus is connected', async () => {
    setBusReadyForTest(true);

    const res = await fetch(`${baseUrl()}/ready`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ready');
    expect(json.bus).toMatchObject({ connected: true });
    expect(json.dependencies).toBeDefined();
  });

  it('reports not ready when the bus is disconnected', async () => {
    setBusReadyForTest(false);

    const res = await fetch(`${baseUrl()}/ready`);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe('not_ready');
    expect(json.bus).toMatchObject({ reason: 'override', connected: true });
  });

  it('fails safety-check requests fast when the bus is not ready', async () => {
    setBusReadyForTest(false);

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json?.error?.code).toBe('upstream_unavailable');
  });
});
