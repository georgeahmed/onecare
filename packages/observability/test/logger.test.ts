import { describe, it, expect, afterEach, vi } from 'vitest';

import { logger, redact } from '../src/logger';

describe('logger redaction', () => {
  it('redacts transcript fields', () => {
    const payload = {
      transcript: 'patient described chest pain',
      transcriptionText: 'raw text',
      other: 'safe-value',
    };

    const redacted = redact(payload);
    expect(redacted.transcript).toBe('[REDACTED]');
    expect(redacted.transcriptionText).toBe('[REDACTED]');
    expect(redacted.other).toBe('safe-value');
  });

  it('redacts secrets, identifiers, and header-like data', () => {
    const payload = {
      apiKey: 'live-api-key',
      clientSecret: 'super-secret',
      metadata: {
        contactNumber: '+44 7700 900123',
        nhsNumber: '123 456 7890',
        nested: {
          sessionToken: 'session-abc',
          refreshToken: 'refresh-xyz',
          note: 'Call back on 0208 555 1234',
        },
      },
      headers: {
        Authorization: 'Bearer token-value',
        'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
      },
      rawJson: '{"token":"abc","nested":{"refreshToken":"xyz"}}',
    };

    const redacted = redact(payload) as Record<string, unknown>;
    const metadata = redacted.metadata as Record<string, unknown>;
    const nested = metadata.nested as Record<string, unknown>;
    const headers = redacted.headers as Record<string, unknown>;

    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.clientSecret).toBe('[REDACTED]');
    expect(metadata.contactNumber).toBe('[REDACTED]');
    expect(metadata.nhsNumber).toBe('[REDACTED]');
    expect(nested.sessionToken).toBe('[REDACTED]');
    expect(nested.refreshToken).toBe('[REDACTED]');
    expect(nested.note).not.toMatch(/\d{3}/);
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers['Proxy-Authorization']).toBe('[REDACTED]');
    expect(String(redacted.rawJson)).toContain('[REDACTED]');
    expect(String(redacted.rawJson)).not.toContain('token-value');

    expect(redact('Authorization: Bearer some-token')).toBe('Authorization: [REDACTED]');
    expect(redact('apiKey="secret123"')).toBe('apiKey="[REDACTED]"');
    expect(redact('sessionToken=abc')).toBe('sessionToken=[REDACTED]');
  });

  it('handles Map and Set values without leaking sensitive data', () => {
    const payload = {
      payloadMap: new Map([
        ['sessionToken', 'map-token'],
        ['safeKey', 'safe'],
      ]),
      payloadSet: new Set(['+44 7700 900111', 'ok']),
    };

    const redacted = redact(payload) as Record<string, unknown>;
    const map = redacted.payloadMap as Record<string, unknown>;
    const set = redacted.payloadSet as unknown[];

    expect(map.sessionToken).toBe('[REDACTED]');
    expect(map.safeKey).toBe('safe');
    expect(set).toContain('[REDACTED]');
    expect(set).toContain('ok');
  });
});

describe('logger output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles circular references safely', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const loop: unknown[] = [];
    loop.push(loop);
    payload.loop = loop;

    logger.info('circular payload', { payload });

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.payload.self).toBe('[REDACTED]');
    expect(logged.payload.loop).toEqual(['[REDACTED]']);
  });

  it('redacts binary-like values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const buffer = Buffer.from('sensitive');
    const view = new Uint8Array([1, 2, 3]);

    logger.info('binary payload', { buffer, view });

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.buffer).toBe('[REDACTED]');
    expect(logged.view).toBe('[REDACTED]');
  });
});
