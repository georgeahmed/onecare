import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { SecurityServices } from '@onecare/security';
import { setSecurityServices, resetSecurityServices, setConsentEvidenceForTest } from '../src/adapters/security';

let server: import('http').Server;
let baseUrl: () => string;
let setBusReadyForTest: (ready: boolean) => void;

const PATIENT_ID = 'patient-123';

function installSecurityStub(): void {
  const services: SecurityServices = {
    verifySignatureAndReplayGuard: vi.fn().mockResolvedValue(true),
    authorize: vi.fn().mockResolvedValue(true),
    checkConsent: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }),
  };
  setSecurityServices(services);
}

describe('booking slots query validation', () => {
  beforeAll(async () => {
    process.env.BUS_IMPL = 'memory';
    process.env.BOOKING_AVAILABILITY_URL = 'https://booking.example.com/api/';
    const mod = await import('../src/index');
    server = mod.server;
    setBusReadyForTest = mod.setBusReadyForTest;
    baseUrl = () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server not listening');
      }
      return `http://127.0.0.1:${(address as AddressInfo).port}`;
    };
    setConsentEvidenceForTest(PATIENT_ID, 'care', {
      reference: 'Consent/fixture',
      purpose: 'care',
      resources: ['QuestionnaireResponse'],
    });
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
  });

  afterAll(async () => {
    delete process.env.BUS_IMPL;
    delete process.env.BOOKING_AVAILABILITY_URL;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    setBusReadyForTest(true);
    installSecurityStub();
    setConsentEvidenceForTest(PATIENT_ID, 'care', {
      reference: 'Consent/test',
      purpose: 'care',
      resources: ['QuestionnaireResponse'],
    });
  });

  afterEach(() => {
    resetSecurityServices();
    vi.restoreAllMocks();
  });

  function authHeaders(): Record<string, string> {
    return {
      authorization: 'Bearer token',
      'x-request-id': 'req-booking',
      'x-actor-id': PATIENT_ID,
      'x-actor-type': 'patient',
      'x-auth-scope': 'booking:read',
      'x-patient-id': PATIENT_ID,
    };
  }

  it('rejects booking requests missing required parameters', async () => {
    const res = await fetch(
      `${baseUrl()}/booking/slots?serviceType=acute-consult&windowStart=2025-01-01T08:00:00Z`,
      {
        method: 'GET',
        headers: authHeaders(),
      }
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload?.error?.code).toBe('invalid_input');
  });

  it('rejects booking requests with unexpected parameters', async () => {
    const url = `${baseUrl()}/booking/slots?serviceType=acute-consult&windowStart=2025-01-01T08:00:00Z&windowEnd=2025-01-01T09:00:00Z&foo=bar`;
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload?.error?.code).toBe('invalid_input');
  });

  it('rejects booking requests with malformed values', async () => {
    const url = `${baseUrl()}/booking/slots?serviceType=acute consult&windowStart=not-a-date&windowEnd=2025-01-01T09:00:00Z`;
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
    });

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload?.error?.code).toBe('invalid_input');
  });
});
