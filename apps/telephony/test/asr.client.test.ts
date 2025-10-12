import { describe, it, expect } from 'vitest';
import { buildCallTranscribed, AsrClientError } from '../src/adapters/asr.client';

describe('buildCallTranscribed', () => {
  it('normalizes transcript, language, and patient identifiers', () => {
    const payload = buildCallTranscribed({
      callId: ' call-123 ',
      transcription: {
        text: '  hello world  ',
        lang: ' en-US ',
      },
      context: {
        patientId: '  patient-42  ',
      },
    });

    expect(payload.callId).toBe('call-123');
    expect(payload.transcript).toBe('hello world');
    expect(payload.lang).toBe('en-US');
    expect(payload.patientId).toBe('patient-42');
  });

  it('throws when transcript is empty after normalization', () => {
    let caught: unknown;
    try {
      buildCallTranscribed({
        callId: 'call-123',
        transcription: { text: '   ' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AsrClientError);
    expect((caught as AsrClientError).code).toBe('transcript_required');
    expect((caught as Error).message).toBe('transcription text is required');
  });

  it('preserves null language and patientId when provided explicitly', () => {
    const payload = buildCallTranscribed({
      callId: 'call-123',
      transcription: {
        text: 'hello',
        lang: null,
      },
      context: {
        patientId: null,
      },
    });

    expect(payload.lang).toBeNull();
    expect(payload.patientId).toBeNull();
  });
});
