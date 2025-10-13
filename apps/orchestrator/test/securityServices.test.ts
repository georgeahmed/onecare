import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { getSecurityServices, resetSecurityServices } from '../src/adapters/security';

const originalEnv = process.env.SECURITY_REPLAY_WINDOW_MS;
const originalSecret = process.env.SECURITY_SHARED_SECRET;
const SHARED_SECRET = 'unit-test-secret';

function sign(payload: string): string {
  return createHmac('sha256', SHARED_SECRET).update(payload).digest('base64url');
}

describe('default security services', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00Z') });
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.SECURITY_REPLAY_WINDOW_MS;
    } else {
      process.env.SECURITY_REPLAY_WINDOW_MS = originalEnv;
    }
    if (originalSecret === undefined) {
      delete process.env.SECURITY_SHARED_SECRET;
    } else {
      process.env.SECURITY_SHARED_SECRET = originalSecret;
    }
    resetSecurityServices();
  });

  it('falls back to default replay window when env is invalid', async () => {
    process.env.SECURITY_REPLAY_WINDOW_MS = 'not-a-number';
    resetSecurityServices();
    const security = getSecurityServices();

    const requestId = 'req-123';
    const header = `Bearer ${sign(requestId)}`;

    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);

    vi.advanceTimersByTime(300_001);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
  });

  it('respects small configured replay window', async () => {
    process.env.SECURITY_REPLAY_WINDOW_MS = '2000';
    resetSecurityServices();
    const security = getSecurityServices();

    const requestId = 'req-2000';
    const header = `Bearer ${sign(requestId)}`;

    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);

    vi.advanceTimersByTime(2_001);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
  });

  it('rejects requests when shared secret is missing', async () => {
    delete process.env.SECURITY_SHARED_SECRET;
    resetSecurityServices();
    const security = getSecurityServices();
    const requestId = 'req-secret-missing';
    const header = `Bearer ${sign(requestId)}`;
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);
  });

  it('rejects requests with invalid signatures', async () => {
    resetSecurityServices();
    const security = getSecurityServices();
    const requestId = 'req-invalid';
    const header = 'Bearer invalid-token';
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);
  });
});
