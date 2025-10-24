import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentServiceClassifier } from '../../apps/telephony/src/adapters/intent.client';
import { StubIntentClassifier } from '../../apps/telephony/src/adapters/intent.classifier';

const createJsonResponse = (status: number, body: unknown, headers?: Record<string, string>) => {
  const headerMap = new Map<string, string>();
  Object.entries(headers ?? { 'content-type': 'application/json' }).forEach(([key, value]) => {
    headerMap.set(key.toLowerCase(), value);
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  } as unknown as Response;
};

describe('IntentServiceClassifier', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('prefers keyword configuration without calling remote service', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => createJsonResponse(200, { intent: 'telephony.remote' }));
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub/classify',
      apiKey: 'demo-key',
      keywordIntents: [
        { intent: 'telephony.emergency', keywords: ['emergency'], confidence: 0.94 },
        { intent: 'telephony.medication', keywords: ['prescription'] },
      ],
      fetchImpl: fetchMock,
    });

    const result = await classifier.classify({
      callId: 'call-101',
      transcript: 'This is an EMERGENCY and I need help now',
      lang: 'en-US',
    });

    expect(result).toEqual({ intent: 'telephony.emergency', confidence: 0.94 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the intent service when no keyword matches', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers && (init.headers as Record<string, string>)['x-api-key']).toBe('demo-key');
      expect(init?.headers && (init.headers as Record<string, string>)['x-correlation-id']).toBe('corr-1');
      return createJsonResponse(200, { intent: 'telephony.callback', confidence: 0.77 });
    });
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub/classify',
      apiKey: 'demo-key',
      keywordIntents: [],
      fetchImpl: fetchMock,
    });

    const result = await classifier.classify({
      callId: 'call-remote',
      transcript: 'Just checking in about my appointment',
      correlationId: 'corr-1',
    });

    expect(result).toEqual({ intent: 'telephony.callback', confidence: 0.77 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.headers && (init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse((init?.body as string) ?? '{}')).toMatchObject({
      callId: 'call-remote',
      transcript: 'Just checking in about my appointment',
    });
  });

  it('uses fallback classifier when the intent service is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => createJsonResponse(503, { error: 'offline' }));
    const fallback = new StubIntentClassifier({
      defaultIntent: 'telephony.handoff',
      confidence: 0.51,
    });
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub/classify',
      apiKey: 'demo-key',
      keywordIntents: [],
      fetchImpl: fetchMock,
      fallback,
    });

    const result = await classifier.classify({
      callId: 'call-503',
      transcript: 'I need assistance with my medication schedule',
    });

    expect(result).toEqual({ intent: 'telephony.handoff', confidence: 0.51 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces configuration errors when authentication fails', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => createJsonResponse(401, { error: 'invalid api key' }));
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub/classify',
      apiKey: 'bad-key',
      keywordIntents: [],
      fetchImpl: fetchMock,
    });

    await expect(
      classifier.classify({
        callId: 'call-unauth',
        transcript: 'I have a billing question',
      }),
    ).rejects.toMatchObject({ code: 'intent_classifier_configuration' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns default intent when transcript is empty', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const classifier = new IntentServiceClassifier({
      baseUrl: 'https://intent.stub/classify',
      apiKey: 'demo-key',
      defaultIntent: 'telephony.callback',
      defaultConfidence: 0.6,
      keywordIntents: [],
      fetchImpl: fetchMock,
    });

    const result = await classifier.classify({
      callId: 'call-empty',
      transcript: '   ',
    });

    expect(result).toEqual({ intent: 'telephony.callback', confidence: 0.6 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
