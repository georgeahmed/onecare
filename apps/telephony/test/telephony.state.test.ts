import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscribedState, IntentClassifiedState, RoutedState } from '../src/application/telephony.state';
import type { TelephonyContext } from '../src/application/types';
import { buildCallTranscribed } from '../src/adapters/asr.client';
import type { MessageBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type CallTranscribed, type IntentClassified } from '@onecare/events';

describe('Telephony state machine', () => {
  let publishSpy: ReturnType<typeof vi.fn>;
  let classifySpy: ReturnType<typeof vi.fn>;
  let bus: MessageBus;

  beforeEach(() => {
    publishSpy = vi.fn(async () => {});
    classifySpy = vi.fn(async () => ({
      intent: 'telephony.callback',
      confidence: 0.42,
    }));
    bus = {
      publish: publishSpy,
      subscribe: vi.fn(async () => ({
        unsubscribe: async () => {},
      })),
    };
  });

  describe('TranscribedState', () => {
    it('transcribes audio, publishes call transcribed event, and seeds intent input', async () => {
      const transcribe = vi.fn(async () => ({
        text: '  thank you for calling  ',
        lang: ' en-GB ',
      }));

      const ctx: TelephonyContext = {
        id: 'call-001',
        callId: 'call-001',
        audioRef: 'memory://call-001',
        correlationId: 'corr-123',
        patientId: '  patient-9  ',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        now: () => 1_725_000_000_000,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.3,
      };

      const state = new TranscribedState();
      const next = await state.handle(ctx, { type: 'telephony.call.received' });

      expect(next).toBe('IntentClassified');
      expect(transcribe).toHaveBeenCalledWith('call-001', 'memory://call-001');

      expect(ctx.callTranscribed).toMatchObject({
        callId: 'call-001',
        transcript: 'thank you for calling',
        lang: 'en-GB',
        patientId: 'patient-9',
      });
      expect(ctx.intentClassificationInput).toEqual({
        callId: 'call-001',
        transcript: 'thank you for calling',
        lang: 'en-GB',
        patientId: 'patient-9',
        correlationId: 'corr-123',
      });
      expect(ctx.intentConfidenceThreshold).toBeCloseTo(0.3);

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const [topic, envelope, headers] = publishSpy.mock.calls[0] as [
        string,
        TypedEnvelope<CallTranscribed>,
        Record<string, string> | undefined,
      ];
      expect(topic).toBe(Topics.telephony.callTranscribed);
      expect(envelope.payload).toMatchObject({
        callId: 'call-001',
        transcript: 'thank you for calling',
      });
      expect(headers).toEqual({ 'x-correlation-id': 'corr-123' });
      expect(ctx.callTranscribedEnvelope).toEqual(envelope);
      expect(ctx.callTranscribedPublishedAt).toBe(1_725_000_000_000);
    });

    it('throws when call transcribed event fails to publish', async () => {
      publishSpy.mockRejectedValue(new Error('bus offline'));

      const transcribe = vi.fn(async () => ({
        text: 'hello',
      }));

      const ctx: TelephonyContext = {
        id: 'call-002',
        callId: 'call-002',
        audioRef: 'memory://call-002',
        correlationId: 'corr-456',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.4,
      };

      const state = new TranscribedState();

      await expect(state.handle(ctx, { type: 'telephony.call.received' })).rejects.toThrowError(
        'call_transcribed_publish_failed',
      );

      expect(transcribe).toHaveBeenCalledOnce();
      expect(ctx.callTranscribedPublishedAt).toBeUndefined();
    });
  });

  describe('IntentClassifiedState', () => {
    it('classifies intent, publishes event, and stores result', async () => {
      const transcribe = vi.fn(async () => ({
        text: 'check symptoms',
      }));

      const ctx: TelephonyContext = {
        id: 'call-003',
        callId: 'call-003',
        audioRef: 'memory://call-003',
        correlationId: 'corr-789',
        asrClient: { transcribe },
        buildCallTranscribed,
        patientId: 'patient-X',
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.35,
      };

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      const next = await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(next).toBe('Routed');
      expect(classifySpy).toHaveBeenCalledWith({
        callId: 'call-003',
        transcript: 'check symptoms',
        lang: null,
        patientId: 'patient-X',
        correlationId: 'corr-789',
      });
      expect(ctx.intentClassificationResult).toEqual({
        intent: 'telephony.callback',
        confidence: 0.42,
      });
      expect(ctx.intentClassified).toEqual({
        callId: 'call-003',
        intent: 'telephony.callback',
        confidence: 0.42,
      });
      expect(ctx.intentClassifiedEnvelope?.payload.intent).toBe('telephony.callback');
      expect(ctx.intentClassifiedPublishedAt).toBeDefined();
      expect(ctx.intentRoutingDecision).toBe('auto');
      expect(publishSpy).toHaveBeenLastCalledWith(
        Topics.telephony.intentClassified,
        expect.objectContaining({
          payload: expect.objectContaining({ callId: 'call-003', intent: 'telephony.callback' }),
        }) as TypedEnvelope<IntentClassified>,
        { 'x-correlation-id': 'corr-789' },
      );
    });

    it('throws when intent classifier is missing', async () => {
      const intentState = new IntentClassifiedState();
      await expect(
        intentState.handle(
          {
            id: 'call-005',
            callId: 'call-005',
            intentClassificationInput: {
              callId: 'call-005',
              transcript: 'hello',
            },
            bus,
            intentConfidenceThreshold: 0.6,
          } as unknown as TelephonyContext,
          { type: 'telephony.intent.classified' },
        ),
      ).rejects.toThrowError('intent_classifier_missing');
    });

    it('throws when intent classified event fails to publish', async () => {
      publishSpy.mockRejectedValue(new Error('bus offline'));

      const intentState = new IntentClassifiedState();
      const ctx: TelephonyContext = {
        id: 'call-006',
        callId: 'call-006',
        intentClassificationInput: {
          callId: 'call-006',
          transcript: 'needs antibiotics',
        },
        intentClassifier: { classify: classifySpy },
        bus,
        intentConfidenceThreshold: 0.4,
      };

      await expect(intentState.handle(ctx, { type: 'telephony.intent.classified' })).rejects.toThrowError(
        'intent_classified_publish_failed',
      );
      expect(ctx.intentClassifiedPublishedAt).toBeUndefined();
    });

    it('throws when intent classification input is missing', async () => {
      const intentState = new IntentClassifiedState();
      await expect(
        intentState.handle(
          {
            id: 'call-004',
            callId: 'call-004',
            intentClassifier: { classify: classifySpy },
            bus,
            intentConfidenceThreshold: 0.5,
          } as TelephonyContext,
          { type: 'telephony.intent.classified' },
        ),
      ).rejects.toThrowError('intent_input_missing');
    });

    it('marks low confidence classifications for fallback routing', async () => {
      classifySpy.mockResolvedValueOnce({
        intent: 'telephony.manual_review',
        confidence: 0.2,
      });

      const transcribe = vi.fn(async () => ({
        text: 'need help',
      }));

      const ctx: TelephonyContext = {
        id: 'call-007',
        callId: 'call-007',
        audioRef: 'memory://call-007',
        correlationId: 'corr-low',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.8,
      };

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(ctx.intentRoutingDecision).toBe('fallback');
      expect(ctx.intentClassified?.intent).toBe('telephony.manual_review');
      expect(ctx.intentClassified?.confidence).toBeCloseTo(0.2);
      expect(ctx.intentConfidenceThreshold).toBeCloseTo(0.8);

      const routedState = new RoutedState();
      const routed = await routedState.handle(ctx, { type: 'telephony.call.routed' });
      expect(routed).toBe('Routed');
    });
  });

  describe('RoutedState', () => {
    it('logs routing decision when intent classified payload is present', async () => {
      const state = new RoutedState();
      const ctx: TelephonyContext = {
        id: 'call-010',
        callId: 'call-010',
        intentClassified: {
          callId: 'call-010',
          intent: 'telephony.callback',
        },
        correlationId: 'corr-route',
        intentRoutingDecision: 'auto',
      };

      const next = await state.handle(ctx, { type: 'telephony.call.routed' });
      expect(next).toBe('Routed');
    });

    it('throws if classification payload is missing', async () => {
      const state = new RoutedState();
      await expect(
        state.handle(
          {
            id: 'call-011',
            callId: 'call-011',
            intentRoutingDecision: 'fallback',
          } as TelephonyContext,
          { type: 'telephony.call.routed' },
        ),
      ).rejects.toThrowError('intent_classified_missing');
    });
  });
});
