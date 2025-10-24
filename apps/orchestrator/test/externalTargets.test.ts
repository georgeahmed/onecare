import { describe, expect, it } from 'vitest';
import { normalizeExternalServiceBase } from '../src/support/externalTargets';

describe('normalizeExternalServiceBase', () => {
  it('normalizes an HTTPS URL and strips search/hash fragments', () => {
    const url = normalizeExternalServiceBase('https://booking.example/api?foo=bar#section', {
      envName: 'TEST_URL',
      allowHttp: true,
      allowHttps: true,
      allowLoopback: false,
    });
    expect(url.toString()).toBe('https://booking.example/api');
  });

  it('rejects non-http protocols', () => {
    expect(() =>
      normalizeExternalServiceBase('ftp://booking.example', {
        envName: 'TEST_URL',
        allowHttp: true,
        allowHttps: true,
        allowLoopback: false,
      }),
    ).toThrow(/http\(s\)/i);
  });

  it('rejects loopback hosts when not allowed', () => {
    expect(() =>
      normalizeExternalServiceBase('http://127.0.0.1:4000', {
        envName: 'TEST_URL',
        allowHttp: true,
        allowHttps: true,
        allowLoopback: false,
      }),
    ).toThrow(/loopback/i);
  });

  it('rejects IPv4-mapped loopback hosts when not allowed', () => {
    expect(() =>
      normalizeExternalServiceBase('http://[::ffff:127.0.0.1]:8080', {
        envName: 'TEST_URL',
        allowHttp: true,
        allowHttps: true,
        allowLoopback: false,
      }),
    ).toThrow(/loopback/i);
  });

  it('allows loopback hosts when explicitly permitted', () => {
    const url = normalizeExternalServiceBase('http://127.0.0.1:4000', {
      envName: 'TEST_URL',
      allowHttp: true,
      allowHttps: true,
      allowLoopback: true,
    });
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.toString()).toBe('http://127.0.0.1:4000/');
  });

  it('blocks metadata service addresses', () => {
    expect(() =>
      normalizeExternalServiceBase('http://169.254.169.254/latest', {
        envName: 'TEST_URL',
        allowHttp: true,
        allowHttps: true,
        allowLoopback: true,
      }),
    ).toThrow(/metadata/i);
  });
});
