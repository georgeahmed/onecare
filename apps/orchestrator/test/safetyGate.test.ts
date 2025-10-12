import { describe, it, expect } from 'vitest';
import { analyzePortalSubmission, parseJsonOrThrow } from '../src/adapters/services/safetyGate';

const sample = {
  practiceId: 'p1',
  patient: { id: 'abc' },
  narrative: 'test',
  channel: 'web' as const,
};

describe('safetyGate SSRF guard', () => {
  it('blocks localhost/loopback endpoints', async () => {
    await expect(
      analyzePortalSubmission(sample, 'http://localhost:8081', 'corr')
    ).rejects.toBeTruthy();
    await expect(
      analyzePortalSubmission(sample, 'http://127.0.0.1:8081', 'corr')
    ).rejects.toBeTruthy();
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
