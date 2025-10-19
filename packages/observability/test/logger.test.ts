import { describe, it, expect } from 'vitest';

import { redact } from '../src/logger';

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
});
