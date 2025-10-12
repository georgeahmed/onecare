import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CallReceivedState,
  LanguageSelectionState,
  TranscribedState,
  IntentClassifiedState,
  EmergencyTransferState,
  RoutedState,
} from '../src/application/telephony.state';
import type { TelephonyContext } from '../src/application/types';
import { buildCallTranscribed } from '../src/adapters/asr.client';
import type { MessageBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type CallTranscribed, type IntentClassified } from '@onecare/events';
import {
  applyTelephonyDependencies,
  setIntentClassifier,
  setIntentClassifierFactory,
} from '../src/application/bootstrap';

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
    setIntentClassifierFactory(undefined);
    setIntentClassifier(undefined);
  });

  afterEach(() => {
    setIntentClassifier(undefined);
    setIntentClassifierFactory(undefined);
  });

  describe('CallReceivedState', () => {
    it('normalises call metadata and transitions to language selection', async () => {
      const transcribe = vi.fn(async () => ({ text: 'hello' }));
      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-000',
        callId: ' call-000 ',
        audioRef: ' memory://call-000 ',
        metadata: { callerId: '  caller-99  ' },
        patientId: ' patient-99 ',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
      } as TelephonyContext);

      const state = new CallReceivedState();
      const next = await state.handle(ctx, { type: 'telephony.call.received' });

      expect(next).toBe('LanguageSelection');
      expect(ctx.callId).toBe('call-000');
      expect(ctx.audioRef).toBe('memory://call-000');
      expect(ctx.metadata?.callerId).toBe('caller-99');
      expect(ctx.selectedLanguage).toBe('en');
    });
  });

  describe('LanguageSelectionState', () => {
    it('queues prompt keys from config and defaults to English fallback', async () => {
      const transcribe = vi.fn(async () => ({ text: 'language test' }));
      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-lang',
        callId: 'call-lang',
        audioRef: 'memory://call-lang',
        metadata: { callerId: 'caller-123', practiceId: 'nhs_gp_defaults' },
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
      } as TelephonyContext);

      const receivedState = new CallReceivedState();
      await receivedState.handle(ctx, { type: 'telephony.call.received' });

      const languageState = new LanguageSelectionState();
      const next = await languageState.handle(ctx, { type: 'telephony.language.selection' });

      expect(next).toBe('Transcribed');
      expect(ctx.availableLanguages).toEqual(expect.arrayContaining(['en', 'ur', 'pa', 'pl', 'ar']));
      expect(ctx.languagePromptSelections?.length).toBe(ctx.availableLanguages?.length);
      expect(ctx.ivrPrompts?.[0]).toBe('ivr.prompt.language.select');
      expect(ctx.ivrPrompts).toContain('ivr.prompt.language.option.en');
      expect(ctx.selectedLanguage).toBe('en');
      const optionKeys = ctx.languagePromptSelections?.map((entry) => entry.promptKey) ?? [];
      expect(optionKeys).toContain('ivr.prompt.language.option.ur');
    });
  });

  describe('TranscribedState', () => {
    it('transcribes audio, publishes call transcribed event, and seeds intent input', async () => {
      const transcribe = vi.fn(async () => ({
        text: '  thank you for calling  ',
        lang: ' en-GB ',
      }));

      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-001',
        callId: 'call-001',
        audioRef: 'memory://call-001',
        correlationId: 'corr-123',
        patientId: '  patient-9  ',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        now: () => 1_725_000_000_000,
        intentConfidenceThreshold: 0.3,
      } as TelephonyContext);

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

      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-002',
        callId: 'call-002',
        audioRef: 'memory://call-002',
        correlationId: 'corr-456',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentConfidenceThreshold: 0.4,
      } as TelephonyContext);

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

      const ctx: TelephonyContext = applyTelephonyDependencies({
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
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      const next = await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(next).toBe('Routed');
      expect(classifySpy).toHaveBeenCalledWith({
        callId: 'call-003',
        transcript: 'check symptoms',
        lang: 'en',
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
      expect(ctx.intentRouteTarget).toBe('triage');
      expect(ctx.intentRouteReason).toBe('triage_pipeline');
      expect(ctx.triageInput?.patientId).toBe('patient-X');
      expect(ctx.triageInput?.features?.intent).toBe('telephony.callback');
      expect(ctx.intentClassifiedEnvelope?.payload.intent).toBe('telephony.callback');
      expect(ctx.intentClassifiedPublishedAt).toBeDefined();
      expect(ctx.triageInputEnvelope?.payload.patientId).toBe('patient-X');
      expect(ctx.triageInputPublishedAt).toBeDefined();
      expect(ctx.callbackWindowOptions).toEqual({
        priority: 'routine',
        windowCode: 'within_48h',
        windowLabel: 'We can call you back within 48 hours.',
      });
      expect(ctx.intentRoutingDecision).toBe('auto');
      expect(publishSpy).toHaveBeenCalledTimes(3);
      expect(publishSpy).toHaveBeenCalledWith(
        Topics.telephony.intentClassified,
        expect.objectContaining({
          payload: expect.objectContaining({ callId: 'call-003', intent: 'telephony.callback' }),
        }) as TypedEnvelope<IntentClassified>,
        { 'x-correlation-id': 'corr-789' },
      );
      const publishTopics = publishSpy.mock.calls.map((call) => call[0]);
      expect(publishTopics).toContain(Topics.triage.input);
    });

    it('publishes triage input with narrative when patient present', async () => {
      const transcribe = vi.fn(async () => ({
        text: 'Caller reports severe sore throat and fever',
      }));

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-012',
        callId: 'call-012',
        audioRef: 'memory://call-012',
        correlationId: 'corr-triage',
        asrClient: { transcribe },
        buildCallTranscribed,
        patientId: 'patient-12',
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.3,
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(publishSpy).toHaveBeenCalledTimes(3);
      const triageCall = publishSpy.mock.calls.find(([topic]) => topic === Topics.triage.input);
      expect(triageCall).toBeDefined();
      const [, triageEnvelope] = triageCall as [string, TypedEnvelope<TriageInput>];
      expect(triageEnvelope.payload.patientId).toBe('patient-12');
      expect(triageEnvelope.payload.narrative).toMatch(/sore throat/i);
      expect(triageEnvelope.payload.features?.intent).toBeDefined();
      expect(ctx.triageInputEnvelope?.payload.patientId).toBe('patient-12');
      expect(ctx.intentRouteTarget).toBe('triage');
      expect(ctx.intentRouteReason).toBe('triage_pipeline');
      expect(ctx.callbackWindowOptions?.priority).toBe('routine');
      expect(ctx.ivrPrompts?.at(-1)).toMatch(/call you back/i);
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
      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-006',
        callId: 'call-006',
        intentClassificationInput: {
          callId: 'call-006',
          transcript: 'needs antibiotics',
        },
        intentClassifier: { classify: classifySpy },
        bus,
        intentConfidenceThreshold: 0.4,
      } as TelephonyContext);

      await expect(intentState.handle(ctx, { type: 'telephony.intent.classified' })).rejects.toThrowError(
        'intent_classified_publish_failed',
      );
      expect(ctx.intentClassifiedPublishedAt).toBeUndefined();
      expect(publishSpy).toHaveBeenCalledTimes(1);
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

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-007',
        callId: 'call-007',
        audioRef: 'memory://call-007',
        correlationId: 'corr-low',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.8,
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      const nextState = await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(nextState).toBe('EmergencyTransfer');
      expect(ctx.intentRoutingDecision).toBe('emergency');
      expect(ctx.intentRouteTarget).toBe('emergency');
      expect(ctx.intentRouteReason).toBe('emergency_transfer');
      expect(ctx.intentClassified?.intent).toBe('telephony.manual_review');
      expect(ctx.intentClassified?.confidence).toBeCloseTo(0.2);
      expect(ctx.intentConfidenceThreshold).toBeCloseTo(0.8);
      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(ctx.callbackWindowOptions?.priority).toBe('stat');

      const emergencyState = new EmergencyTransferState();
      const afterEmergency = await emergencyState.handle(ctx, { type: 'telephony.emergency.transfer' });
      expect(afterEmergency).toBe('Routed');
      expect(ctx.ivrPrompts?.at(-1)).toMatch(/emergency services/i);
      expect(ctx.emergencyTransferAt).toBeDefined();

      const routedState = new RoutedState();
      const routed = await routedState.handle(ctx, { type: 'telephony.call.routed' });
      expect(routed).toBe('Routed');
    });

    it('respects emergency transfer flag when disabled', async () => {
      classifySpy.mockResolvedValueOnce({
        intent: 'telephony.manual_review',
        confidence: 0.2,
      });

      const transcribe = vi.fn(async () => ({ text: 'need help' }));

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-008',
        callId: 'call-008',
        audioRef: 'memory://call-008',
        correlationId: 'corr-low-disabled',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.8,
        emergencyTransferEnabled: false,
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      const nextState = await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(nextState).toBe('Routed');
      expect(ctx.emergencyTransferTriggered).toBe(false);
      expect(ctx.intentRouteTarget).toBe('triage');
      expect(ctx.intentRouteReason).toBe('triage_pipeline');
      expect(ctx.triageInput).toBeUndefined();
      expect(ctx.intentRoutingDecision).toBe('fallback');
      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(ctx.callbackWindowOptions).toBeUndefined();
    });

    it('maps billing intent to admin routing without triage input', async () => {
      classifySpy.mockResolvedValueOnce({
        intent: 'telephony.billing',
        confidence: 0.65,
      });

      const transcribe = vi.fn(async () => ({ text: 'Question about a bill' }));

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-009',
        callId: 'call-009',
        audioRef: 'memory://call-009',
        correlationId: 'corr-billing',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.5,
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      const nextState = await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(nextState).toBe('Routed');
      expect(ctx.intentRouteTarget).toBe('billing');
      expect(ctx.intentRouteReason).toBe('billing_support');
      expect(ctx.triageInput).toBeUndefined();
      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(ctx.callbackWindowOptions).toBeUndefined();
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
        intentRouteTarget: 'triage',
        triageInput: {
          patientId: 'patient-010',
          narrative: 'telephony narrative',
          features: { intent: 'telephony.callback' },
        },
        callbackWindowOptions: {
          priority: 'routine',
          windowCode: 'within_48h',
          windowLabel: 'We can call you back within 48 hours.',
        },
      };

      const next = await state.handle(ctx, { type: 'telephony.call.routed' });
      expect(next).toBe('Routed');
      expect(ctx.callbackWindowOptions?.windowLabel).toBe('We can call you back within 48 hours.');
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
