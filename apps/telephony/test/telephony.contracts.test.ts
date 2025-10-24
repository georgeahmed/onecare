import { describe, it, expect } from 'vitest';
import { validateCallTranscribed, validateIntentClassified } from '@onecare/events';

describe('telephony contract validators', () => {
  it('accepts valid call transcribed payloads', () => {
    const result = validateCallTranscribed({
      callId: 'call-123',
      transcript: 'Caller describes symptoms',
      patientId: 'patient-123',
      lang: 'en',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.callId).toBe('call-123');
    }
  });

  it('rejects invalid call transcribed payloads', () => {
    const result = validateCallTranscribed({
      callId: '',
      transcript: '',
      patientId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('/callId');
      expect(paths).toContain('/transcript');
    }
  });

  it('accepts valid intent classified payloads', () => {
    const result = validateIntentClassified({
      callId: 'call-456',
      intent: 'telephony.callback',
      confidence: 0.8,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent).toBe('telephony.callback');
    }
  });

  it('rejects invalid intent classified payloads', () => {
    const result = validateIntentClassified({
      callId: '',
      intent: '',
      confidence: 1.7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('/callId');
      expect(paths).toContain('/intent');
    }
  });
});
