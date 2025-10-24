import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter, RateLimiter } from '../../apps/orchestrator/src/support/limits';
import { errorEnvelope, mapErrorToStatus } from '../../apps/orchestrator/src/application/error';

describe('Backpressure and rate limits', () => {
  it('returns 429 with retry guidance when rate limit exceeded', () => {
    const limiter = new RateLimiter(
      { maxRequests: 2, windowMs: 1_000, blockMs: 5_000 },
      { '/safety-check': { maxRequests: 1, windowMs: 500, blockMs: 2_000 } },
    );
    const identity = 'ip:192.0.2.10';

    const first = limiter.check('/safety-check', identity);
    expect(first.allowed).toBe(true);
    const second = limiter.check('/safety-check', identity);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    const envelope = errorEnvelope('too_many_requests', 'Slow down', {
      retryAfterSeconds: second.retryAfterSeconds,
      route: '/safety-check',
    });
    const status = mapErrorToStatus(envelope.error.code);

    expect(status).toBe(429);
    expect(envelope.error.details?.retryAfterSeconds).toBe(second.retryAfterSeconds);
    expect(envelope.error.details?.route).toBe('/safety-check');
  });

  it('sheds load with 503 when concurrency budget exhausted, then recovers', () => {
    const limiter = new ConcurrencyLimiter({
      globalLimit: 2,
      defaultRouteLimit: 1,
      perRoute: {
        '/booking/confirm': 1,
        '/safety-check': 1,
      },
    });

    const releaseSafety = limiter.enter('/safety-check');
    const releaseBooking = limiter.enter('/booking/confirm');
    expect(typeof releaseSafety).toBe('function');
    expect(typeof releaseBooking).toBe('function');

    const denied = limiter.enter('/booking/confirm');
    expect(denied).toBeNull();

    const envelope = errorEnvelope('busy', 'System is processing existing requests', {
      route: '/booking/confirm',
      active: limiter.active('/booking/confirm'),
    });
    const status = mapErrorToStatus(envelope.error.code);
    expect(status).toBe(503);
    expect(envelope.error.details?.active).toBe(1);

    releaseSafety?.();
    releaseBooking?.();
    expect(limiter.active()).toBe(0);

    const afterRecovery = limiter.enter('/booking/confirm');
    expect(typeof afterRecovery).toBe('function');
  });
});
