import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { URL } from 'node:url';
import { once } from 'node:events';

const ALLOWLISTED_URL = 'https://example.com';

let server: http.Server;
let serverUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/redirect-private') {
      res.writeHead(302, { Location: 'http://127.0.0.1:80' });
      res.end();
      return;
    }
    if (url.pathname === '/redirect-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address && typeof address === 'object') {
    serverUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function callBooking(url: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ url });
  return new Promise((resolve, reject) => {
    const req = http.request(
      'http://localhost:3002/booking/proxy',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe.skip('SSRF guardrails (requires booking proxy endpoint)', () => {
  it('allows allowlisted public host', async () => {
    const { status } = await callBooking(ALLOWLISTED_URL);
    expect([200, 502, 504]).toContain(status);
  });

  it('blocks redirect to 127.0.0.1', async () => {
    const { status, body } = await callBooking(`${serverUrl}/redirect-private`);
    expect(status).toBe(400);
    expect(body).toContain('upstream_blocked');
  });

  it('blocks redirect to metadata service', async () => {
    const { status, body } = await callBooking(`${serverUrl}/redirect-metadata`);
    expect(status).toBe(400);
    expect(body).toContain('upstream_blocked');
  });
});
