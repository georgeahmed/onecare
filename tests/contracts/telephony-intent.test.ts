import { describe, it, expect, vi } from 'vitest';
import { IntentServiceClassifier } from '../../apps/telephony/src/adapters/intent.client';
import { IntentClassifierError } from '../../apps/telephony/src/adapters/intent.classifier';

describe('Telephony Intent Service contract', () => {
  it('sends JSON payload with expected fields and headers', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        text: 'need appointment',
        lang: 'en-US',
        callId: 'call-123',
        patientId: 'pat-9',
        correlationId: 'corr-1',
      });
      return new Response(JSON.stringify({ intent: 'telephony.callback', confidence: 0.87 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.local',
      apiKey: 'secret',
      path: '/v1/classify',
      timeoutMs: 500,
      fetchImpl: fetchMock,
    });

    const result = await classifier.classify({
      callId: 'call-123',
      transcript: 'need appointment',
      lang: 'en-US',
      patientId: 'pat-9',
      correlationId: 'corr-1',
    });

    expect(result).toEqual({ intent: 'telephony.callback', confidence: 0.87 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://intent.local/v1/classify');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer secret',
    });
  });

  it('throws contract error when response omits intent', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.local',
      fetchImpl: fetchMock,
    });

    await expect(
      classifier.classify({
        callId: 'call-1',
        transcript: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'intent_classifier_invalid_response' } satisfies IntentClassifierError);
  });
});

