import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { PortalSubmission } from '@onecare/events';
import { InMemoryIdempotencyStore, deriveIdempotencyKey } from '../src/application/idempotency';
import {
  server,
  setBusReadyForTest,
  getMessageBusForTest,
  setIdempotencyStoreForTest,
  resetIdempotencyStoreForTest,
  resetShutdownStateForTest,
} from '../src/index';
import { resetSecurityServices } from '../src/adapters/security';
import { setConsentFixtureEnv } from './consentFixture';
import { PRACTICE_ID } from './practice';

vi.mock('../src/adapters/services/safetyGate', async () => {
  const actual = await vi.importActual<typeof import('../src/adapters/services/safetyGate')>(
    '../src/adapters/services/safetyGate'
  );
  return {
    ...actual,
    analyzePortalSubmission: vi.fn().mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE' }),
  };
});

const envBackup = process.env.MAX_BODY_BYTES;
const busImplBackup = process.env.BUS_IMPL;
const natsUrlBackup = process.env.NATS_URL;
const secretBackup = process.env.SECURITY_SHARED_SECRET;
let baseUrl: string;
const SHARED_SECRET = 'test-shared-secret';

function url(): string {
  if (baseUrl) return baseUrl;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return baseUrl;
}

async function post(endpoint: string, payload: PortalSubmission, requestId: string): Promise<Response> {
  const actorId = payload.patient.id;
  const idemKey = deriveIdempotencyKey(payload, actorId);
  const fingerprint = `${requestId}:${idemKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signature}`,
      'content-type': 'application/json',
      'x-actor-type': 'patient',
      'x-actor-id': actorId,
      'x-request-id': requestId,
      'x-auth-scope': 'submit',
    },
    body: JSON.stringify(payload),
  });
}

async function postWithContentType(
  endpoint: string,
  payload: PortalSubmission,
  requestId: string,
  contentType: string,
): Promise<Response> {
  const actorId = payload.patient.id;
  const idemKey = deriveIdempotencyKey(payload, actorId);
  const fingerprint = `${requestId}:${idemKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signature}`,
      'content-type': contentType,
      'x-actor-type': 'patient',
      'x-actor-id': actorId,
      'x-request-id': requestId,
      'x-auth-scope': 'submit',
    },
    body: JSON.stringify(payload),
  });
}

function decodeChunkedBody(raw: string): string {
  let remainder = raw;
  let result = '';

  while (remainder.length > 0) {
    const chunkEnd = remainder.indexOf('\r\n');
    if (chunkEnd === -1) break;
    const lengthHex = remainder.slice(0, chunkEnd);
    const length = parseInt(lengthHex, 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      return result;
    }
    const chunkStart = chunkEnd + 2;
    const chunkContent = remainder.slice(chunkStart, chunkStart + length);
    result += chunkContent;
    remainder = remainder.slice(chunkStart + length + 2);
  }
  return result;
}

async function postRawWithHeaderOverride(
  payload: PortalSubmission,
  requestId: string,
  headerName: string,
  headerValue: string,
): Promise<{ status: number; headers: Map<string, string>; bodyText: string }> {
  const actorId = payload.patient.id;
  const idemKey = deriveIdempotencyKey(payload, actorId);
  const fingerprint = `${requestId}:${idemKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  const body = JSON.stringify(payload);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  const port = (address as AddressInfo).port;

  const headerLines = [
    `Host: 127.0.0.1:${port}`,
    'Connection: close',
    'content-type: application/json',
    'x-actor-type: patient',
    `x-actor-id: ${actorId}`,
    `x-request-id: ${requestId}`,
    'x-auth-scope: submit',
    `authorization: Bearer ${signature}`,
    `${headerName}: ${headerValue}`,
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
  ];

  const request = `POST /safety-check HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n${body}`;

  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let response = '';

    socket.setTimeout(5_000);

    socket.on('connect', () => {
      socket.write(request);
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });

    socket.on('timeout', () => {
      socket.destroy(new Error('request timeout'));
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on('end', () => {
      try {
        const separator = response.indexOf('\r\n\r\n');
        if (separator === -1) {
          reject(new Error('invalid HTTP response'));
          return;
        }
        const headerSection = response.slice(0, separator);
        const bodySection = response.slice(separator + 4);
        const [statusLine, ...rawHeaderLines] = headerSection.split('\r\n');
        const status = Number(statusLine.split(' ')[1]);
        const headers = new Map<string, string>();
        for (const line of rawHeaderLines) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const name = line.slice(0, idx).toLowerCase();
          const value = line.slice(idx + 1).trim();
          headers.set(name, value);
        }
        let bodyText = bodySection;
        if ((headers.get('transfer-encoding') ?? '').toLowerCase() === 'chunked') {
          bodyText = decodeChunkedBody(bodySection);
        }
        resolve({ status, headers, bodyText });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('request limits', () => {
  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    getMessageBusForTest(); // ensure bus initialised
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (busImplBackup === undefined) {
      delete process.env.BUS_IMPL;
    } else {
      process.env.BUS_IMPL = busImplBackup;
    }
    if (natsUrlBackup === undefined) {
      delete process.env.NATS_URL;
    } else {
      process.env.NATS_URL = natsUrlBackup;
    }
    if (secretBackup === undefined) {
      delete process.env.SECURITY_SHARED_SECRET;
    } else {
      process.env.SECURITY_SHARED_SECRET = secretBackup;
    }
  });

  beforeEach(() => {
    baseUrl = '';
    resetShutdownStateForTest();
    setBusReadyForTest(true);
    setIdempotencyStoreForTest(new InMemoryIdempotencyStore());
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    setConsentFixtureEnv();
    resetSecurityServices();
  });

  afterEach(() => {
    resetIdempotencyStoreForTest();
    if (envBackup === undefined) {
      delete process.env.MAX_BODY_BYTES;
    } else {
      process.env.MAX_BODY_BYTES = envBackup;
    }
  });

  it('rejects large payloads when MAX_BODY_BYTES is invalid', async () => {
    process.env.MAX_BODY_BYTES = 'not-a-number';
    const submission: PortalSubmission = {
      practiceId: PRACTICE_ID,
      patient: { id: 'patient-123' },
      narrative: 'x'.repeat(300_000),
      channel: 'web' as const,
    };

    const res = await post(`${url()}/safety-check`, submission, 'req-body-limit');

    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body?.error?.code).toBe('payload_too_large');
  });

  it('accepts larger payloads when size suffix is provided', async () => {
    process.env.MAX_BODY_BYTES = '512k';
    const submission: PortalSubmission = {
      practiceId: PRACTICE_ID,
      patient: { id: 'patient-123' },
      narrative: 'x'.repeat(400_000),
      channel: 'web' as const,
    };

    const res = await post(`${url()}/safety-check`, submission, 'req-size-suffix');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.outcome).toBe('SAFE_TO_CONTINUE');
  });

  it('enforces pre-auth rate limiting', async () => {
    const buildSubmission = (suffix: number): PortalSubmission => ({
      practiceId: PRACTICE_ID,
      patient: { id: 'patient-rate' },
      narrative: `check rate limiter ${suffix}`,
      channel: 'web' as const,
    });

    for (let i = 0; i < 40; i += 1) {
      const res = await post(`${url()}/safety-check`, buildSubmission(i), `req-rate-${i}`);
      expect(res.status).toBe(200);
      await res.json();
    }

    const blocked = await post(`${url()}/safety-check`, buildSubmission(100), 'req-rate-block');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    const body = await blocked.json();
    expect(body?.error?.code).toBe('too_many_requests');
  });

  it('rejects unsupported content-type before reading body', async () => {
    process.env.MAX_BODY_BYTES = '1024';
    const submission: PortalSubmission = {
      practiceId: PRACTICE_ID,
      patient: { id: 'patient-unsupported' },
      narrative: 'x'.repeat(200_000),
      channel: 'web' as const,
    };

    const res = await postWithContentType(`${url()}/safety-check`, submission, 'req-wrong-ctype', 'text/plain');

    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body?.error?.code).toBe('unsupported_media_type');
  });

  it('rejects requests containing control characters in headers', async () => {
    const submission: PortalSubmission = {
      practiceId: PRACTICE_ID,
      patient: { id: 'patient-headers' },
      narrative: 'invalid header test',
      channel: 'web' as const,
    };

    const { status, bodyText } = await postRawWithHeaderOverride(
      submission,
      'req-invalid-header',
      'x-bad-header',
      'value\u0007with-bell',
    );

    expect(status).toBe(400);
    const parsed = JSON.parse(bodyText);
    expect(parsed?.error?.code).toBe('invalid_input');
  });
});
