import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as configModule from '@onecare/config';
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
import type { IdempotencyStore } from '@onecare/ports';
import {
  Topics,
  type TypedEnvelope,
  type CallTranscribed,
  type IntentClassified,
  type TriageInput,
} from '@onecare/events';
import {
  applyTelephonyDependencies,
  setIntentClassifier,
  setIntentClassifierFactory,
} from '../src/application/bootstrap';
import { TelephonyContractError } from '../src/application/errors';
import { resetMetrics, getCounterRecords, getHistogramRecords } from '@onecare/observability';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('Telephony state machine', () => {
let publishSpy: ReturnType<typeof vi.fn>;
let classifySpy: ReturnType<typeof vi.fn>;
let bus: MessageBus;

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    reserve: async (key: string) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, true);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

  beforeEach(() => {
    resetMetrics();
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

  describe('TranscribedState feature flags', () => {
    it('drops detected language and diarization when feature disabled', async () => {
      const realLoadConfig = configModule.loadConfig;
      const loadConfigSpy = vi.spyOn(configModule, 'loadConfig').mockImplementation((practiceId: string) => {
        const base = realLoadConfig(practiceId);
        const telephony = isRecord(base.telephony) ? (base.telephony as Record<string, unknown>) : {};
        const asr = isRecord(telephony.asr) ? (telephony.asr as Record<string, unknown>) : {};
        return {
          ...base,
          telephony: {
            ...telephony,
            asr: {
              ...asr,
              lang_detect: false,
              diarization: false,
            },
          },
        };
      });

      const transcribe = vi.fn(async () => ({
        text: 'bonjour',
        lang: 'fr-FR',
        diarization: [{ speaker: 'speaker-1', startMs: 0, endMs: 1200 }],
      }));

      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-lang-disable',
        callId: 'call-lang-disable',
        audioRef: 'memory://call-lang-disable',
        correlationId: 'corr-disable',
        metadata: { callerId: '+15550000099', practiceId: 'nhs_gp_defaults' },
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
      } as TelephonyContext);

      const state = new TranscribedState();
      await state.handle(ctx, { type: 'telephony.call.received' });

      expect(ctx.callTranscribed?.lang).toBe('en');
      expect(ctx.transcription?.lang).toBeUndefined();
      expect(ctx.diarizationSummary).toBeUndefined();

      loadConfigSpy.mockRestore();
    });

    it('captures diarization summary when feature enabled', async () => {
      const realLoadConfig = configModule.loadConfig;
      const loadConfigSpy = vi.spyOn(configModule, 'loadConfig').mockImplementation((practiceId: string) => {
        const base = realLoadConfig(practiceId);
        const telephony = isRecord(base.telephony) ? (base.telephony as Record<string, unknown>) : {};
        const asr = isRecord(telephony.asr) ? (telephony.asr as Record<string, unknown>) : {};
        return {
          ...base,
          telephony: {
            ...telephony,
            asr: {
              ...asr,
              lang_detect: true,
              diarization: true,
            },
          },
        };
      });

      const transcribe = vi.fn(async () => ({
        text: 'hola mundo',
        lang: 'es-ES',
        diarization: [
          { speaker: 'spk1', startMs: 0, endMs: 1000 },
          { speaker: 'spk2', startMs: 1500, endMs: 2500 },
        ],
      }));

      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-lang-enable',
        callId: 'call-lang-enable',
        audioRef: 'memory://call-lang-enable',
        correlationId: 'corr-enable',
        metadata: { callerId: '+15550000088', practiceId: 'nhs_gp_defaults' },
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
      } as TelephonyContext);

      const state = new TranscribedState();
      await state.handle(ctx, { type: 'telephony.call.received' });

      expect(ctx.callTranscribed?.lang).toBe('es-ES');
      expect(ctx.callTranscribed).not.toHaveProperty('diarization');
      expect(ctx.diarizationSummary).toEqual([
        { speaker: 'spk1', startMs: 0, endMs: 1000 },
        { speaker: 'spk2', startMs: 1500, endMs: 2500 },
      ]);

      loadConfigSpy.mockRestore();
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
      expect(ctx.intentClassificationInput).toMatchObject({
        callId: 'call-001',
        transcript: 'thank you for calling',
        lang: 'en-GB',
        patientId: 'patient-9',
        correlationId: 'corr-123',
      });
      expect(ctx.intentClassificationInput?.practiceId).toBeTruthy();
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
      expect(headers).toMatchObject({ 'x-correlation-id': 'corr-123' });
      expect(ctx.callTranscribedEnvelope).toEqual(envelope);
      expect(ctx.callTranscribedPublishedAt).toBe(1_725_000_000_000);
    });

    it('prevents duplicate call transcribed publishes when idempotency key repeats', async () => {
      const store = createIdempotencyStore();
      const transcribe = vi.fn(async () => ({ text: 'first run' }));

      const ctx = applyTelephonyDependencies({
        id: 'call-idem',
        callId: 'call-idem',
        audioRef: 'memory://call-idem',
        correlationId: 'corr-idem',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        idempotencyStore: store,
        callTranscribedIdempotencyKey: 'telephony:call-transcribed:call-idem',
      } as TelephonyContext);

      const state = new TranscribedState();
      await state.handle(ctx, { type: 'telephony.call.received' });
      expect(publishSpy).toHaveBeenCalledTimes(1);

      const duplicateCtx = applyTelephonyDependencies({
        id: 'call-idem-dup',
        callId: 'call-idem',
        audioRef: 'memory://call-idem',
        correlationId: 'corr-idem',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        idempotencyStore: store,
        callTranscribedIdempotencyKey: 'telephony:call-transcribed:call-idem',
      } as TelephonyContext);

      await state.handle(duplicateCtx, { type: 'telephony.call.received' });
      expect(publishSpy).toHaveBeenCalledTimes(1);
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

    it('rejects invalid call transcribed payloads via schema validation', async () => {
      const transcribe = vi.fn(async () => ({ text: '  sample transcript  ' }));

      setIntentClassifier({ classify: classifySpy });
      const ctx = applyTelephonyDependencies({
        id: 'call-invalid-contract',
        callId: 'call-invalid-contract',
        audioRef: 'memory://call-invalid-contract',
        correlationId: 'corr-invalid',
        asrClient: { transcribe },
        buildCallTranscribed: () => ({
          callId: 'call-invalid-contract',
        } as unknown as CallTranscribed),
        bus,
      } as TelephonyContext);

      const state = new TranscribedState();
      await state.handle(ctx, { type: 'telephony.call.received' }).then(
        () => {
          throw new Error('expected call transcribed validation to fail');
        },
        (error) => {
          expect(error).toBeInstanceOf(TelephonyContractError);
          expect(error).toMatchObject({ code: 'call_transcribed_invalid' });
        },
      );
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
      expect(classifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'call-003',
          transcript: 'check symptoms',
          lang: 'en',
          patientId: 'patient-X',
          correlationId: 'corr-789',
        }),
      );
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
      const classificationCall = publishSpy.mock.calls.find((call) => call[0] === Topics.telephony.intentClassified);
      expect(classificationCall).toBeDefined();
      const [, classificationEnvelope, classificationHeaders] = classificationCall as [
        string,
        TypedEnvelope<IntentClassified>,
        Record<string, string> | undefined,
      ];
      expect(classificationEnvelope.payload).toMatchObject({
        callId: 'call-003',
        intent: 'telephony.callback',
      });
      expect(classificationHeaders).toMatchObject({ 'x-correlation-id': 'corr-789' });
      const publishTopics = publishSpy.mock.calls.map((call) => call[0]);
      expect(publishTopics).toContain(Topics.triage.input);
    });

    it('suppresses duplicate intent publication and triage routing when idempotency key is reused', async () => {
      const store = createIdempotencyStore();
      const transcribe = vi.fn(async () => ({ text: 'needs callback' }));

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-intent',
        callId: 'call-intent',
        audioRef: 'memory://call-intent',
        correlationId: 'corr-intent',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        idempotencyStore: store,
        callTranscribedIdempotencyKey: 'telephony:call-transcribed:call-intent',
        intentClassifiedIdempotencyKey: 'telephony:intent-classified:call-intent',
        triagePublishIdempotencyKey: 'telephony:triage:call-intent',
        intentClassifier: { classify: classifySpy },
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      const publishCount = publishSpy.mock.calls.length;

      const duplicateCtx: TelephonyContext = {
        ...ctx,
        id: 'call-intent-dup',
        intentClassified: undefined,
        intentClassifiedEnvelope: undefined,
        triageInputEnvelope: undefined,
      };

      await intentState.handle(duplicateCtx, { type: 'telephony.intent.classified' });

      expect(publishSpy.mock.calls.length).toBe(publishCount);
    });

    it('records telemetry metrics for a successful pipeline', async () => {
      const transcribe = vi.fn(async () => ({ text: 'metrics pipeline run' }));
      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-metrics',
        callId: 'call-metrics',
        audioRef: 'memory://call-metrics',
        correlationId: 'corr-metrics',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
      } as TelephonyContext);

      const callState = new CallReceivedState();
      const languageState = new LanguageSelectionState();
      const transcribedState = new TranscribedState();
      const intentState = new IntentClassifiedState();

      await callState.handle(ctx, { type: 'telephony.call.received' });
      await languageState.handle(ctx, { type: 'telephony.language.selection' });
      await transcribedState.handle(ctx, { type: 'telephony.call.transcribed' });
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      const asrRecords = getCounterRecords('telephony.asr.calls');
      expect(asrRecords).toHaveLength(1);
      expect(asrRecords[0]?.attributes?.outcome).toBe('ok');

      const intentRecords = getCounterRecords('telephony.intent.calls');
      expect(intentRecords).toHaveLength(1);
      expect(intentRecords[0]?.attributes?.outcome).toBe('ok');

      const pipelineRecords = getHistogramRecords('telephony.pipeline_duration_ms');
      expect(pipelineRecords.length).toBeGreaterThan(0);
    });

    it('short-circuits the pipeline when duplicate flag is set', async () => {
      const transcribe = vi.fn(async () => ({ text: 'unique transcript' }));
      const classify = vi.fn(async () => ({ intent: 'telephony.callback', confidence: 0.82 }));
      const enqueuePrompt = vi.fn(async () => {});

      const languageSelection = new LanguageSelectionState();
      const transcribed = new TranscribedState();
      const intentState = new IntentClassifiedState();

      const duplicateCtx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-dup-secondary',
        callId: 'call-dup-secondary',
        audioRef: 'memory://call-dup-secondary',
        correlationId: 'corr-dup',
        asrClient: { transcribe },
        intentClassifier: { classify },
        buildCallTranscribed,
        bus,
        enqueuePrompt,
      } as TelephonyContext);

      duplicateCtx.pipelineDuplicate = true;
      duplicateCtx.pipelineIdempotencyReserved = false;

      const publishCount = publishSpy.mock.calls.length;

      await languageSelection.handle(duplicateCtx, { type: 'telephony.language.selection' });
      await transcribed.handle(duplicateCtx, { type: 'telephony.call.transcribed' });
      await intentState.handle(duplicateCtx, { type: 'telephony.intent.classified' });

      expect(transcribe).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(publishSpy.mock.calls.length).toBe(publishCount);
      expect(enqueuePrompt).not.toHaveBeenCalled();
      expect(duplicateCtx.intentClassified).toBeUndefined();
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

    it('rejects invalid intent classified payloads via schema validation', async () => {
      const intentState = new IntentClassifiedState();
      const classify = vi.fn(async () => ({ intent: 'telephony.callback', confidence: 0.7 }));
      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-invalid-intent',
        callId: 'call-invalid-intent',
        intentClassificationInput: {
          callId: '',
          transcript: 'hello world',
        },
        intentClassifier: { classify },
        bus,
        intentConfidenceThreshold: 0.5,
      } as TelephonyContext);

      await intentState.handle(ctx, { type: 'telephony.intent.classified' }).then(
        () => {
          throw new Error('expected intent classified validation to fail');
        },
        (error) => {
          expect(error).toBeInstanceOf(TelephonyContractError);
          expect(error).toMatchObject({ code: 'intent_classified_invalid' });
        },
      );
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

      const emergencyHandoffSpy = vi.fn(async () => {});
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
        emergencyHandoff: emergencyHandoffSpy,
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
      expect(ctx.emergencyHandoffAt).toBeDefined();
      expect(emergencyHandoffSpy).toHaveBeenCalledTimes(1);
      expect(emergencyHandoffSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'call-007',
          reason: 'emergency_transfer',
          correlationId: 'corr-low',
        }),
      );

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

      const emergencyHandoffSpy = vi.fn(async () => {});
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
        emergencyHandoff: emergencyHandoffSpy,
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
      expect(emergencyHandoffSpy).not.toHaveBeenCalled();
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

    it('builds callback window choices from config', async () => {
      const realLoadConfig = configModule.loadConfig;
      const loadConfigSpy = vi.spyOn(configModule, 'loadConfig').mockImplementation((practiceId: string) => {
        const base = realLoadConfig(practiceId);
        return {
          ...base,
          telephony: {
            ...(isRecord(base.telephony) ? base.telephony : {}),
            callback_windows_by_priority: {
              routine: [
                { code: 'within_48h', label: 'Within 48 hours' },
                { code: 'next_week' },
              ],
            },
          },
        };
      });

      classifySpy.mockResolvedValueOnce({ intent: 'telephony.callback', confidence: 0.5 });
      const transcribe = vi.fn(async () => ({ text: 'follow up' }));

      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: 'call-windows',
        callId: 'call-windows',
        audioRef: 'memory://call-windows',
        correlationId: 'corr-windows',
        metadata: { callerId: '+15550000077', practiceId: 'nhs_gp_defaults' },
        patientId: 'patient-77',
        asrClient: { transcribe },
        buildCallTranscribed,
        bus,
        intentClassifier: { classify: classifySpy },
        intentConfidenceThreshold: 0.4,
      } as TelephonyContext);

      const transcribedState = new TranscribedState();
      await transcribedState.handle(ctx, { type: 'telephony.call.received' });

      const intentState = new IntentClassifiedState();
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });

      expect(ctx.callbackWindowChoices).toEqual([
        { priority: 'routine', windowCode: 'within_48h', windowLabel: 'Within 48 hours' },
        { priority: 'routine', windowCode: 'next_week', windowLabel: 'Next Week' },
      ]);
      expect(ctx.callbackWindowOptions).toEqual({
        priority: 'routine',
        windowCode: 'within_48h',
        windowLabel: 'Within 48 hours',
      });

      loadConfigSpy.mockRestore();
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
