import { CallTranscribed } from '@onecare/events';

export interface TranscriptionResponse {
  text: string;
  lang?: string | null;
}

export interface TranscriptionContext {
  patientId?: string | null;
}

export interface AsrClient {
  transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse>;
}

export type CallTranscribedBuilder = (params: {
  callId: string;
  transcription: TranscriptionResponse;
  context?: TranscriptionContext;
}) => CallTranscribed;

export type TranscriptNormalizer = (text: string) => string;

export interface StubAsrClientOptions {
  normalizer?: TranscriptNormalizer;
  defaultLanguage?: string;
}

const baseNormalizer: TranscriptNormalizer = (text: string) => text.trim();
export const defaultNormalizer = baseNormalizer;

export class StubAsrClient implements AsrClient {
  private readonly normalizer: TranscriptNormalizer;
  private readonly defaultLanguage?: string;

  constructor(options?: StubAsrClientOptions) {
    this.normalizer = options?.normalizer ?? baseNormalizer;
    this.defaultLanguage = options?.defaultLanguage;
  }

  async transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse> {
    if (!callId?.trim()) {
      throw new AsrClientError('call_id_required', 'callId is required for transcription');
    }
    if (!audioRef?.trim()) {
      throw new AsrClientError('audio_ref_required', 'audio reference is required');
    }
    const text = this.normalizer(`transcript for ${callId}`);
    return {
      text,
      lang: this.defaultLanguage ?? null,
    };
  }
}

export class AsrClientError extends Error {
  constructor(public readonly code: AsrClientErrorCode, message: string) {
    super(message);
    this.name = 'AsrClientError';
  }
}

export type AsrClientErrorCode = 'call_id_required' | 'audio_ref_required' | 'transcript_required';

export const buildCallTranscribed: CallTranscribedBuilder = ({ callId, transcription, context }) => {
  const normalizedCallId = callId?.trim();
  if (!normalizedCallId) {
    throw new AsrClientError('call_id_required', 'callId is required to build CallTranscribed payload');
  }
  const transcript = transcription?.text ? baseNormalizer(transcription.text) : '';
  if (!transcript) {
    throw new AsrClientError('transcript_required', 'transcription text is required');
  }

  const payload: CallTranscribed = {
    callId: normalizedCallId,
    transcript,
  };

  const lang = transcription?.lang ?? null;
  if (lang) {
    payload.lang = lang;
  } else if (lang === null) {
    payload.lang = null;
  }

  if (context && 'patientId' in context) {
    payload.patientId = context.patientId ?? null;
  }

  return payload;
};
