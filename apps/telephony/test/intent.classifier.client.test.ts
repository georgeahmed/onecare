import { describe, it, expect, vi } from 'vitest';
import { IntentClassifierClient } from '../src/adapters/intent.classifier.client';
import type { IntentClassificationInput, IntentClassifier } from '../src/adapters/intent.classifier';
import {
  resetMetrics,
  getCounterRecords,
  getHistogramRecords,
} from '@onecare/observability';

describe('IntentClassifierClient', () => {
  beforeEach(() => {
    resetMetrics();
  });

  const buildInput = (overrides?: Partial<IntentClassificationInput>): IntentClassificationInput => ({
    callId: 'call-1',
    transcript: 'i need help',
    lang: 'en',
    practiceId: 'practice-1',
    correlationId: 'corr-1',
    ...(overrides ?? {}),
  });

  it('records success metrics and logs on classifier success', async () => {
    const classify = vi.fn(async () => ({ intent: 'telephony.callback', confidence: 0.9 }));
    const client = new IntentClassifierClient({
      classifier: { classify } satisfies IntentClassifier,
    });

    const input = buildInput();
    const result = await client.classify(input);

    expect(result).toEqual({ intent: 'telephony.callback', confidence: 0.9 });
    expect(getCounterRecords('intent.classify.ok')).toHaveLength(1);
    expect(getHistogramRecords('intent.confidence')).toHaveLength(1);
  });

  it('records error metric and rethrows on classifier failure', async () => {
    const classify = vi.fn(async () => {
      throw new Error('classifier offline');
    });
    const client = new IntentClassifierClient({
      classifier: { classify } satisfies IntentClassifier,
    });

    const input = buildInput();
    await expect(client.classify(input)).rejects.toThrowError('classifier offline');
    expect(getCounterRecords('intent.classify.error')).toHaveLength(1);
    expect(getCounterRecords('intent.classify.ok')).toHaveLength(0);
  });
});
