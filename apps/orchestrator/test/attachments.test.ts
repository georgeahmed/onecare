import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { SecurityServices } from '@onecare/security';
import { setSecurityServices, resetSecurityServices, setConsentEvidenceForTest } from '../src/adapters/security';
import { setConsentFixtureEnv, consentReference } from './consentFixture';

const submission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'Persistent headache',
  channel: 'web' as const,
  attachments: [
    { contentType: 'image/png', url: 'https://example.com/report.png' },
  ],
};

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;

function baseUrl(): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server not listening');
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function installAllowAllSecurity(): void {
  setConsentFixtureEnv();
  const verify = vi.fn<SecurityServices['verifySignatureAndReplayGuard']>().mockResolvedValue(true);
  const authorize = vi.fn<SecurityServices['authorize']>().mockResolvedValue(true);
  const consent = vi.fn<SecurityServices['checkConsent']>().mockImplementation(async (patientId, purpose, resources) => {
    const refPurpose = purpose === 'analytics-lite' ? 'analytics-lite' : 'care';
    setConsentEvidenceForTest(patientId, purpose, {
      reference: consentReference(patientId, refPurpose),
      purpose,
      resources,
    });
    return true;
  });
  setSecurityServices({ verifySignatureAndReplayGuard: verify, authorize, checkConsent: consent });
}

describe('attachment validation', () => {
  beforeAll(async () => {
    delete process.env.NATS_URL;
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
    setBusReadyForTest(true);
    installAllowAllSecurity();
  });

  afterEach(() => {
    resetSecurityServices();
    vi.restoreAllMocks();
  });

  it('rejects attachments that are not HTTPS', async () => {
    const body = {
      ...submission,
      attachments: [{ contentType: 'image/png', url: 'http://example.com/report.png' }],
    };
    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'req-http',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload?.error?.code).toBe('invalid_input');
    expect(String(payload?.error?.message)).toMatch(/https/i);
  });

  it('rejects attachments pointing to private hosts', async () => {
    const body = {
      ...submission,
      attachments: [{ contentType: 'image/png', url: 'https://127.0.0.1/private.png' }],
    };
    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'req-private',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload?.error?.code).toBe('invalid_input');
    expect(String(payload?.error?.message)).toMatch(/host/i);
  });
});
