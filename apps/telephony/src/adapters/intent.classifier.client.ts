import { createCounter, createHistogram, logger } from '@onecare/observability';
import type {
  IntentClassifier,
  IntentClassificationInput,
  IntentClassificationResult,
} from './intent.classifier';

const intentClassifySuccessCounter = createCounter('intent.classify.ok');
const intentClassifyErrorCounter = createCounter('intent.classify.error');
const intentConfidenceHistogram = createHistogram('intent.confidence');

export interface IntentClassifierClientOptions {
  classifier: IntentClassifier;
}

export class IntentClassifierClient {
  private readonly classifier: IntentClassifier;

  constructor(options: IntentClassifierClientOptions) {
    this.classifier = options.classifier;
  }

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    try {
      const result = await this.classifier.classify(input);
      intentClassifySuccessCounter.add(1, {
        practiceId: input.practiceId ?? 'unknown',
        intent: result.intent,
      });
      if (typeof result.confidence === 'number' && Number.isFinite(result.confidence)) {
        intentConfidenceHistogram.record(result.confidence, {
          practiceId: input.practiceId ?? 'unknown',
          intent: result.intent,
        });
      }
      logger.info('telephony.intent.classify.success', {
        callId: input.callId,
        intent: result.intent,
        confidence: result.confidence,
        practiceId: input.practiceId,
        correlationId: input.correlationId,
      });
      return result;
    } catch (error) {
      intentClassifyErrorCounter.add(1, {
        practiceId: input.practiceId ?? 'unknown',
      });
      logger.error('telephony.intent.classify.failed', {
        callId: input.callId,
        practiceId: input.practiceId,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      throw error;
    }
  }
}

export function createIntentClassifierClient(classifier: IntentClassifier): IntentClassifierClient {
  return new IntentClassifierClient({ classifier });
}
