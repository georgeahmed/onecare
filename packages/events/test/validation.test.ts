import { describe, it, expect } from 'vitest';
import {
  validateCallTranscribed,
  validateIntentClassified,
  type ContractValidationError,
} from '../src';

describe('contract validation', () => {
  it('returns ok when call transcribed payload matches schema', () => {
    const outcome = validateCallTranscribed({
      callId: 'call-abc',
      transcript: 'sample transcript',
      lang: 'en',
      patientId: null,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.transcript).toBe('sample transcript');
    }
  });

  it('returns errors when call transcribed payload violates schema', () => {
    const outcome = validateCallTranscribed({
      callId: '',
      transcript: '   ',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      assertHasPath(outcome.errors, '/callId');
    }
  });

  it('returns ok when intent classified payload matches schema', () => {
    const outcome = validateIntentClassified({
      callId: 'call-xyz',
      intent: 'telephony.callback',
    });

    expect(outcome.ok).toBe(true);
  });

  it('returns errors when intent classified payload violates schema', () => {
    const outcome = validateIntentClassified({
      callId: 'call-xyz',
      intent: '',
      confidence: -1,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      assertHasPath(outcome.errors, '/intent');
    }
  });
});

function assertHasPath(errors: ContractValidationError[], path: string): void {
  const paths = errors.map((error) => error.path);
  expect(paths).toContain(path);
}
