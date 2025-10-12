import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSecurityServices, resetSecurityServices } from '../src/adapters/security';

const originalEnv = process.env.SECURITY_REPLAY_WINDOW_MS;

describe('default security services', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2025-01-01T00:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.SECURITY_REPLAY_WINDOW_MS;
    } else {
      process.env.SECURITY_REPLAY_WINDOW_MS = originalEnv;
    }
    resetSecurityServices();
  });

  it('falls back to default replay window when env is invalid', async () => {
    process.env.SECURITY_REPLAY_WINDOW_MS = 'not-a-number';
    resetSecurityServices();
    const security = getSecurityServices();

    const header = 'Bearer token';
    const requestId = 'req-123';

    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);

    vi.advanceTimersByTime(300_001);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
  });

  it('respects small configured replay window', async () => {
    process.env.SECURITY_REPLAY_WINDOW_MS = '2000';
    resetSecurityServices();
    const security = getSecurityServices();

    const header = 'Bearer token';
    const requestId = 'req-2000';

    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(false);

    vi.advanceTimersByTime(2_001);
    expect(await security.verifySignatureAndReplayGuard(header, requestId)).toBe(true);
  });
});
