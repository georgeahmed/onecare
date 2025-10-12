import { describe, it, expect } from 'vitest';
import { IntentServiceClassifier } from '../../apps/telephony/src/adapters/intent.client';
import { StubIntentClassifier } from '../../apps/telephony/src/adapters/intent.classifier';

describe('Telephony Intent Service contract (stub)', () => {
  it('classifies intents based on keyword configuration', async () => {
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub',
      apiKey: 'demo-key',
      defaultIntent: 'telephony.callback',
      defaultConfidence: 0.55,
      keywordIntents: [
        {
          intent: 'telephony.emergency',
          confidence: 0.94,
          keywords: ['emergency', 'ambulance'],
        },
        {
          intent: 'telephony.medication',
          keywords: ['refill', 'prescription'],
        },
      ],
    });

    const emergency = await classifier.classify({
      callId: 'call-101',
      transcript: 'This is an emergency I need an ambulance',
      lang: 'en-US',
    });
    expect(emergency).toEqual({ intent: 'telephony.emergency', confidence: 0.94 });

    const medication = await classifier.classify({
      callId: 'call-102',
      transcript: 'I need a prescription refill for my medication',
    });
    expect(medication).toEqual({ intent: 'telephony.medication', confidence: 0.55 });

    const fallback = await classifier.classify({
      callId: 'call-103',
      transcript: 'Just checking in',
    });
    expect(fallback).toEqual({ intent: 'telephony.callback', confidence: 0.55 });
  });

  it('uses fallback classifier when configured', async () => {
    const fallback = new StubIntentClassifier({
      defaultLanguage: 'en-US',
      normalizer: (text) => text.trim(),
    });
    const classifier = new IntentServiceClassifier({
      fallback,
      defaultIntent: 'telephony.callback',
      keywordIntents: [],
    });

    const result = await classifier.classify({
      callId: 'call-200',
      transcript: '',
    });

    expect(typeof result.intent).toBe('string');
  });
});
