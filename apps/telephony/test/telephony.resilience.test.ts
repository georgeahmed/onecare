import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  HttpAsrClient,
  AsrClientError,
  __resetAsrCircuitBreakers,
  buildCallTranscribed,
} from '../src/adapters/asr.client';
import {
  CallReceivedState,
  LanguageSelectionState,
  TranscribedState,
  IntentClassifiedState,
  RoutedState,
} from '../src/application/telephony.state';
import { applyTelephonyDependencies } from '../src/application/bootstrap';
import type { TelephonyContext } from '../src/application/types';
import type { IdempotencyStore } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

function createResponse(status: number, body: unknown): Response {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: new globalThis.Headers({ 'content-type': 'application/json' }),
  });
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

describe('Telephony resilience', () => {
  beforeEach(() => {
    __resetAsrCircuitBreakers();
  });

  it('retries ASR calls on transient failures and backs off exponentially', async () => {
    let nowMs = 0;
    const sleepCalls: number[] = [];
    const fetchMock = vi.fn(async () => createResponse(500, {}));
    fetchMock
      .mockResolvedValueOnce(createResponse(500, {}))
      .mockResolvedValueOnce(createResponse(502, {}))
      .mockResolvedValueOnce(createResponse(200, { text: 'resolved transcript', lang: 'en' }));

    const client = new HttpAsrClient({
      endpoint: 'https://asr.test/v1/transcribe',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 200,
      maxRetries: 2,
      baseDelayMs: 50,
      hostAllowlist: ['asr.test'],
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        nowMs += ms;
      },
      random: () => 0,
    });

    const result = await client.transcribe('call-transient', 'memory://call-transient');
    expect(result.text).toBe('resolved transcript');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([50, 100]);
  });

  it('opens the ASR circuit after consecutive failures and respects cooldown', async () => {
    let nowMs = 0;
    let allowSuccess = false;
    const fetchMock = vi.fn(async () => {
      if (!allowSuccess) {
        return createResponse(500, {});
      }
      return createResponse(200, { text: 'recovered transcript', lang: 'en' });
    });

    const client = new HttpAsrClient({
      endpoint: 'https://asr.test/v1/transcribe',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 200,
      maxRetries: 0,
      baseDelayMs: 50,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerCooldownMs: 1_000,
      hostAllowlist: ['asr.test'],
      now: () => nowMs,
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(client.transcribe('call-failure', 'memory://call-failure')).rejects.toBeInstanceOf(AsrClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(client.transcribe('call-blocked', 'memory://call-blocked')).rejects.toMatchObject<AsrClientError>({
      code: 'asr_circuit_open',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    allowSuccess = true;
    nowMs += 1_200; // beyond cooldown window

    const recovered = await client.transcribe('call-recovered', 'memory://call-recovered');
    expect(recovered.text).toBe('recovered transcript');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from publish blips without duplicating events', async () => {
    const store = createIdempotencyStore();
    const publishedIntents: string[] = [];
    let failIntentOnce = true;
    const publishSpy = vi.fn(async (topic: string, envelope: unknown) => {
      if (topic === Topics.telephony.intentClassified) {
        if (failIntentOnce) {
          failIntentOnce = false;
          throw new Error('bus offline');
        }
        const typed = envelope as { payload: { intent: string } };
        publishedIntents.push(typed.payload.intent);
      }
    });
    const bus: MessageBus = {
      publish: publishSpy,
      subscribe: async () => ({ unsubscribe: async () => undefined }),
    };

    const transcribe = vi.fn(async () => ({ text: 'retry transcript', lang: 'en' }));
    const classify = vi.fn(async () => ({ intent: 'telephony.callback', confidence: 0.8 }));

    const runPipeline = async (correlationId: string) => {
      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-blip',
        callId: 'call-blip',
        audioRef: 'memory://call-blip',
        correlationId,
        patientId: 'patient-blip',
        asrClient: { transcribe },
        intentClassifier: { classify },
        bus,
        idempotencyStore: store,
        buildCallTranscribed,
      } as TelephonyContext);

      const callState = new CallReceivedState();
      const languageState = new LanguageSelectionState();
      const transcribedState = new TranscribedState();
      const intentState = new IntentClassifiedState();

      await callState.handle(ctx, { type: 'telephony.call.received' });
      await languageState.handle(ctx, { type: 'telephony.language.selection' });
      await transcribedState.handle(ctx, { type: 'telephony.call.transcribed' });
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });
      const routed = new RoutedState();
      await routed.handle(ctx, { type: 'telephony.call.routed' });
    };

    // First run: expect publish failure
    await expect(runPipeline('corr-blip-1')).rejects.toThrowError('intent_classified_publish_failed');
    const callPublishAttempts = publishSpy.mock.calls.filter(([topic]) => topic === Topics.telephony.callTranscribed);
    expect(callPublishAttempts).toHaveLength(1);

    await expect(runPipeline('corr-blip-2')).resolves.toBeUndefined();

    const finalCallPublishes = publishSpy.mock.calls.filter(([topic]) => topic === Topics.telephony.callTranscribed);
    expect(finalCallPublishes).toHaveLength(1);
    expect(publishedIntents).toEqual(['telephony.callback']);
  });
});
