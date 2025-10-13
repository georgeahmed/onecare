import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as dns } from 'node:dns';
import { analyzePortalSubmission, parseJsonOrThrow } from '../src/adapters/services/safetyGate';

const sample = {
  practiceId: 'p1',
  patient: { id: 'abc' },
  narrative: 'test',
  channel: 'web' as const,
};

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
