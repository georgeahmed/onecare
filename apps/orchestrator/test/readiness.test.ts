import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { AddressInfo } from 'node:net';

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;

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

  it('reports ready when the bus is connected', async () => {
    setBusReadyForTest(true);

    const res = await fetch(`${baseUrl()}/ready`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ready', bus: 'connected' });
  });

  it('reports not ready when the bus is disconnected', async () => {
    setBusReadyForTest(false);

    const res = await fetch(`${baseUrl()}/ready`);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({ status: 'not_ready', bus: 'disconnected' });
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
