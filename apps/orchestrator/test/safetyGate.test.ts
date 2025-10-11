import { describe, it, expect } from 'vitest';
import { analyzePortalSubmission } from '../src/adapters/services/safetyGate';

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

