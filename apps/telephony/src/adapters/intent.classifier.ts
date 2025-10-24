import type { IntentClassified } from '@onecare/events';

export type IntentClassifierErrorCode =
  | 'intent_classifier_configuration'
  | 'intent_classifier_unavailable'
  | 'intent_classifier_invalid_response'
  | 'intent_classifier_timeout';

export class IntentClassifierError extends Error {
  constructor(public readonly code: IntentClassifierErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'IntentClassifierError';
  }
}

export interface IntentClassificationInput {
  callId: string;
  transcript: string;
  lang?: string | null;
  patientId?: string | null;
  correlationId?: string;
  practiceId?: string;
}

export interface IntentClassificationResult {
  intent: string;
  confidence?: number;
}

export interface IntentClassifier {
  classify(input: IntentClassificationInput): Promise<IntentClassificationResult>;
}

export interface StubIntentClassifierOptions {
  defaultIntent?: string;
  confidence?: number;
  keywordIntents?: Record<string, string>;
}

export class StubIntentClassifier implements IntentClassifier {
  private readonly defaultIntent: string;
  private readonly confidence?: number;
  private readonly keywordIntents: Record<string, string>;

  constructor(options?: StubIntentClassifierOptions) {
    this.defaultIntent = options?.defaultIntent?.trim() || 'fallback.callback';
    this.confidence = options?.confidence;
    this.keywordIntents = Object.fromEntries(
      Object.entries(options?.keywordIntents ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    const transcript = input.transcript?.toLowerCase() ?? '';
    const match = Object.keys(this.keywordIntents).find((keyword) => transcript.includes(keyword));
    const intent = match ? this.keywordIntents[match] : this.defaultIntent;
    return {
      intent,
      confidence: this.confidence,
    };
  }
}

export function buildIntentClassifiedEvent(
  input: IntentClassificationInput,
  result: IntentClassificationResult,
): IntentClassified {
  const intent = result.intent?.trim();
  if (!intent) {
    throw new IntentClassifierError('intent_classifier_invalid_response', 'intent classifier returned empty intent', result);
  }

  const payload: IntentClassified = {
    callId: input.callId,
    intent,
  };
  if (typeof result.confidence === 'number' && Number.isFinite(result.confidence)) {
    payload.confidence = result.confidence;
  }
  return payload;
}
