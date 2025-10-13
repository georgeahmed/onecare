import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { promises as dns } from 'node:dns';
import {
  analyzePortalSubmission,
  parseJsonOrThrow,
  __safetyGateTesting,
  SafetyGateHttpError,
} from '../src/adapters/services/safetyGate';

const sample = {
  practiceId: 'p1',
  patient: { id: 'abc' },
  narrative: 'test',
  channel: 'web' as const,
};

const { buildSafetyGateHeaders, mapStatusToError, parseRetryAfter, refreshAuthHeaders, MAX_RESPONSE_BYTES } =
  __safetyGateTesting;

describe('safetyGate SSRF guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks localhost/loopback endpoints', async () => {
    await expect(
      analyzePortalSubmission(sample, 'http://localhost:8081', 'corr')
    ).rejects.toBeTruthy();
    await expect(
      analyzePortalSubmission(sample, 'http://127.0.0.1:8081', 'corr')
    ).rejects.toBeTruthy();
  });

  it('blocks domains that resolve to private addresses', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.0.0.4', family: 4 }] as unknown as dns.LookupAddress[]);
    await expect(
      analyzePortalSubmission(sample, 'https://intranet.example', 'corr')
    ).rejects.toThrow(/blocked_private_ip/);
  });

  it('fails fast when DNS resolution fails', async () => {
    const error = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    vi.spyOn(dns, 'lookup').mockRejectedValue(error);
    await expect(
      analyzePortalSubmission(sample, 'https://unresolvable.example', 'corr')
    ).rejects.toThrow(/blocked_host_resolution/);
  });
});

describe('parseJsonOrThrow', () => {
  it('parses valid JSON values', () => {
    const result = parseJsonOrThrow<{ ok: boolean }>(' { "ok": true } ');
    expect(result).toEqual({ ok: true });
  });

  it('throws informative errors for malformed JSON', () => {
    expect(() => parseJsonOrThrow('not-json')).toThrowError(/invalid_json/);
    try {
      parseJsonOrThrow('not-json');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('invalid_json');
      expect((err as { raw?: string }).raw).toBe('not-json');
    }
  });
});

describe('safety gate HTTP adapter helpers', () => {
  beforeEach(() => {
    delete process.env.PY_SAFETY_GATE_AUTH_HEADER_NAME;
    delete process.env.PY_SAFETY_GATE_AUTH_HEADER_VALUE;
    delete process.env.PY_SAFETY_GATE_API_KEY;
    delete process.env.PY_SAFETY_GATE_TOKEN;
    delete process.env.PY_SAFETY_GATE_BEARER_TOKEN;
    delete process.env.PY_SAFETY_GATE_EXTRA_HEADERS;
    refreshAuthHeaders();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PY_SAFETY_GATE_AUTH_HEADER_NAME;
    delete process.env.PY_SAFETY_GATE_AUTH_HEADER_VALUE;
    delete process.env.PY_SAFETY_GATE_API_KEY;
    delete process.env.PY_SAFETY_GATE_TOKEN;
    delete process.env.PY_SAFETY_GATE_BEARER_TOKEN;
    delete process.env.PY_SAFETY_GATE_EXTRA_HEADERS;
    refreshAuthHeaders();
  });

  it('builds headers with configured auth and correlation data', () => {
    process.env.PY_SAFETY_GATE_AUTH_HEADER_NAME = 'x-api-key';
    process.env.PY_SAFETY_GATE_AUTH_HEADER_VALUE = 'legacy-key';
    process.env.PY_SAFETY_GATE_API_KEY = 'should-not-override';
    refreshAuthHeaders();
    const headers = buildSafetyGateHeaders({
      correlationId: 'corr-7',
      requestId: 'req-19',
      scope: ['safety:admin'],
      consentReference: 'consent-abc',
      actor: { id: 'actor-42', type: 'patient' },
    });
    expect(headers).toMatchObject({
      'x-api-key': 'legacy-key',
      'x-correlation-id': 'corr-7',
      'x-request-id': 'req-19',
    });
    expect(headers['x-auth-scope']).toContain('safety:analyze');
    expect(headers['x-auth-scope']).toContain('safety:admin');
    expect(headers['x-consent-reference']).toBe('consent-abc');
    expect(headers['x-actor-id']).toBe('actor-42');
    expect(headers['x-actor-type']).toBe('patient');
    expect(headers.Authorization).toBeUndefined();
  });

  it('adds bearer auth header when configured without explicit override', () => {
    process.env.PY_SAFETY_GATE_API_KEY = 'super-secret';
    refreshAuthHeaders();
    const headers = buildSafetyGateHeaders({});
    expect(headers.Authorization).toBe('Bearer super-secret');
  });

  it('maps retryable status codes and retry-after header', () => {
    const error = mapStatusToError(503, 'oops', { 'retry-after': '3' });
    expect(error).toBeInstanceOf(SafetyGateHttpError);
    expect((error as { code?: string }).code).toBe('temporarily_unavailable');
    expect(error.retryAfterMs).toBe(3000);
  });

  it('parses RFC retry-after dates', () => {
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const result = parseRetryAfter(inTwoSeconds);
    expect(result).toBeGreaterThan(0);
  });

  it('supports injecting custom HTTP client for analysis calls', async () => {
    const client = vi.fn().mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE', reason: 'TEST' });
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as dns.LookupAddress[]);
    await analyzePortalSubmission(sample, 'https://safety.example', {
      correlationId: 'corr-1',
      requestId: 'req-1',
      client,
    });
    expect(client).toHaveBeenCalledTimes(1);
    const [url, payload, headers] = client.mock.calls[0] as [string, typeof sample, Record<string, string>];
    expect(url).toBe('https://safety.example/analyze');
    expect(payload).toBe(sample);
    expect(headers['x-correlation-id']).toBe('corr-1');
    expect(headers['x-request-id']).toBe('req-1');
  });

  it('exposes configured max response bytes for safety checks', () => {
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });
});
