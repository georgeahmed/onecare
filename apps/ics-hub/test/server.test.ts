import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import http from 'node:http';

function makeRequest(server: http.Server, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('server address unavailable'));
      return;
    }
    const options = {
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: 'GET',
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ICS hub server', () => {
  it('serves health and readiness probes', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const health = await makeRequest(server, '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });

    const ready = await makeRequest(server, '/readyz');
    expect([200, 503]).toContain(ready.status);
    expect(() => JSON.parse(ready.body)).not.toThrow();

    server.close();
  });

  it('returns 404 for unknown routes', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const res = await makeRequest(server, '/unknown');
    expect(res.status).toBe(404);

    server.close();
  });
});
