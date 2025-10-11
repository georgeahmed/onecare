import { describe, it, expect } from 'vitest';
import { errorEnvelope, mapErrorToStatus } from '../src/application/error';

describe('error envelope', () => {
  it('maps codes to status', () => {
    expect(mapErrorToStatus('forbidden')).toBe(403);
    expect(mapErrorToStatus('invalid_input')).toBe(400);
    expect(mapErrorToStatus('unsupported_media_type')).toBe(415);
    expect(mapErrorToStatus('payload_too_large')).toBe(413);
    expect(mapErrorToStatus('too_many_requests')).toBe(429);
    expect(mapErrorToStatus('upstream_timeout')).toBe(504);
    expect(mapErrorToStatus('upstream_unavailable')).toBe(503);
    expect(mapErrorToStatus('unauthorized')).toBe(401);
    expect(mapErrorToStatus('conflict')).toBe(409);
    expect(mapErrorToStatus('internal_error')).toBe(500);
  });

  it('creates a safe envelope shape', () => {
    const env = errorEnvelope('invalid_input', 'Invalid body', { field: 'narrative' }, 'corr-1');
    expect(env).toEqual({
      error: {
        code: 'invalid_input',
        message: 'Invalid body',
        details: { field: 'narrative' },
        correlationId: 'corr-1',
      },
    });
  });
});
