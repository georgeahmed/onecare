/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { ensureHttpsUrl, redactForLog, sanitizeMultilineText, sanitizeText } from '../src/lib/security';

describe('security utilities', () => {
  it('sanitizes plain text', () => {
    const input = '  patient-123 \n ';
    expect(sanitizeText(input, 10)).toBe('patient-1…');
  });

  it('sanitizes multiline text and removes control characters', () => {
    const input = 'Line 1\u0000\r\nLine 2\rLine 3';
    expect(sanitizeMultilineText(input)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('allows only https URLs and strips fragments', () => {
    expect(ensureHttpsUrl('https://example.com/path#fragment')).toBe('https://example.com/path');
    expect(ensureHttpsUrl('http://example.com')).toBeNull();
  });

  it('redacts sensitive values recursively', () => {
    const payload = {
      token: 'abc123',
      details: {
        authHeader: 'Bearer secret-token',
        safe: 'ok',
        nested: ['value', { password: 'super-secret' }]
      }
    };
    expect(redactForLog(payload)).toEqual({
      token: '[redacted]',
      details: {
        authHeader: '[redacted]',
        safe: 'ok',
        nested: ['value', { password: '[redacted]' }]
      }
    });
  });
});
