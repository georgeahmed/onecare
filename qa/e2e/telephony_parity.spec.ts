import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Subscription } from '../../packages/bus/src/types';
import { MemoryBus } from '../../packages/bus/src/memoryBus';
import { Topics } from '../../packages/events/src/topics';
import type { TypedEnvelope } from '../../packages/events/src/envelope-util';
import type { CallTranscribed } from '../../packages/events/src/contracts/call-transcribed';
import type { IntentClassified } from '../../packages/events/src/contracts/intent-classified';
import type { TriageInput } from '../../packages/events/src/contracts/triage';
import type { TaskCreated } from '../../packages/events/src/contracts/task-created';
import {
  CallReceivedState,
  LanguageSelectionState,
  TranscribedState,
  IntentClassifiedState,
  EmergencyTransferState,
  RoutedState,
} from '../../apps/telephony/src/application/telephony.state';
import type { TelephonyContext } from '../../apps/telephony/src/application/types';
import { applyTelephonyDependencies } from '../../apps/telephony/src/application/bootstrap';
import type { AsrClient, TranscriptionResponse } from '../../apps/telephony/src/adapters/asr.client';
import type {
  IntentClassifier,
  IntentClassificationInput,
  IntentClassificationResult,
} from '../../apps/telephony/src/adapters/intent.classifier';
import type { ResolvedConfig } from '@onecare/config';
import type { FhirRepository, FhirResourceRef, IdempotencyStore, QueueNotifier } from '@onecare/ports';
import { InMemoryQueueNotifier } from '@onecare/ports';
import { TriageConsumer, type TriageConsumerOptions } from '../../apps/triage/src/adapters/consumer';

interface CapturedMessage<T> {
  envelope: TypedEnvelope<T>;
  headers?: Record<string, string>;
}

interface TelephonyPlaybackScenario {
  callId: string;
  audioRef: string;
  patientId: string;
  transcript: string;
  intent: string;
  confidence: number;
  correlationId: string;
  language?: string;
}

class PlaybackAsrClient implements AsrClient {
  constructor(private readonly transcripts: Map<string, TranscriptionResponse>) {}

  async transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse> {
    if (!audioRef?.trim()) {
      throw new Error('audio_ref_required');
    }
    const entry = this.transcripts.get(callId);
    if (!entry) {
      throw new Error(`transcript_not_found:${callId}`);
    }
    return entry;
  }
}

class PlaybackIntentClassifier implements IntentClassifier {
  constructor(
    private readonly outputs: Map<
      string,
      {
        transcript: string;
        result: IntentClassificationResult;
      }
    >,
  ) {}

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    const entry = this.outputs.get(input.callId);
    if (!entry) {
      throw new Error(`intent_fixture_missing:${input.callId}`);
    }
    if (input.transcript.trim() !== entry.transcript) {
      throw new Error(`transcript_mismatch:${input.callId}`);
    }
    return entry.result;
  }
}

function buildConfig(): ResolvedConfig {
  return {
    practiceId: 'demo',
    triage: {
      score_weights: {
        acuity: 1,
        risk: 0.5,
        complexity: 0.25,
        time: 0.25,
      },
    },
    priority_thresholds: {
      stat: 0.9,
      urgent: 0.6,
      soon: 0.3,
      routine: 0,
    },
  };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, number>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, Date.now() + ttlSeconds * 1_000);
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, Date.now() + ttlSeconds * 1_000);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

function createFhirRepository(overrides: {
  createTask?: (task: unknown, options?: unknown) => Promise<FhirResourceRef>;
} = {}): FhirRepository {
  return {
    async upsertBundle() {
      return { resourceType: 'Bundle', type: 'collection', entry: [] };
    },
    createTask: overrides.createTask ?? (async () => ({ id: 'task-fixture', resourceType: 'Task' })),
    async createAppointment() {
      throw new Error('not_supported');
    },
    async createDocumentReference() {
      throw new Error('not_supported');
    },
  };
}

function createTriageConsumerOptions(
  bus: MemoryBus,
  queueNotifier: QueueNotifier,
  createTask: () => Promise<FhirResourceRef>,
): TriageConsumerOptions {
  const config = buildConfig();
  return {
    bus,
    config,
    queueNotifier,
    fhirRepository: createFhirRepository({ createTask }),
    ingressIdempotencyStore: createIdempotencyStore(),
    taskIdempotencyStore: createIdempotencyStore(),
  };
}

function buildPlaybackClients(
  scenarios: TelephonyPlaybackScenario[],
): {
  asrClient: PlaybackAsrClient;
  intentClassifier: PlaybackIntentClassifier;
} {
  const transcriptMap = new Map<string, TranscriptionResponse>();
  const intentMap = new Map<
    string,
    {
      transcript: string;
      result: IntentClassificationResult;
    }
  >();
  scenarios.forEach((scenario) => {
    transcriptMap.set(scenario.callId, {
      text: scenario.transcript,
      lang: scenario.language ?? 'en',
    });
    intentMap.set(scenario.callId, {
      transcript: scenario.transcript.trim(),
      result: {
        intent: scenario.intent,
        confidence: scenario.confidence,
      },
    });
  });
  return {
    asrClient: new PlaybackAsrClient(transcriptMap),
    intentClassifier: new PlaybackIntentClassifier(intentMap),
  };
}

async function captureTopic<T>(
  bus: MemoryBus,
  topic: string,
  sink: CapturedMessage<T>[],
  subscriptions: Subscription[],
): Promise<void> {
  const subscription = await bus.subscribe<TypedEnvelope<T>>(topic, async (msg) => {
    sink.push({ envelope: msg.payload, headers: msg.headers });
  });
  subscriptions.push(subscription);
}

describe('Telephony parity E2E', () => {
  let bus: MemoryBus;
  let subscriptions: Subscription[];
  let triageConsumer: TriageConsumer | undefined;

  beforeEach(() => {
    bus = new MemoryBus();
    subscriptions = [];
    triageConsumer = undefined;
  });

  afterEach(async () => {
    await triageConsumer?.stop();
    triageConsumer = undefined;
    for (const sub of subscriptions.splice(0)) {
      await sub.unsubscribe();
    }
    vi.restoreAllMocks();
  });

  it('publishes telephony events, routes to triage, and preserves orchestrator contracts', async () => {
    const scenario: TelephonyPlaybackScenario = {
      callId: 'call-tele-001',
      audioRef: 'memory://call-tele-001',
      patientId: 'patient-tele-001',
      transcript: 'Caller needs nurse callback about lab results',
      intent: 'telephony.callback',
      confidence: 0.92,
      correlationId: 'corr-tele-001',
      language: 'en',
    };

    const callEvents: CapturedMessage<CallTranscribed>[] = [];
    const intentEvents: CapturedMessage<IntentClassified>[] = [];
    const triageEvents: CapturedMessage<TriageInput>[] = [];
    const taskEvents: CapturedMessage<TaskCreated>[] = [];

    await captureTopic(bus, Topics.telephony.callTranscribed, callEvents, subscriptions);
    await captureTopic(bus, Topics.telephony.intentClassified, intentEvents, subscriptions);
    await captureTopic(bus, Topics.triage.input, triageEvents, subscriptions);
    await captureTopic(bus, Topics.tasks.created, taskEvents, subscriptions);

    const queueNotifier = new InMemoryQueueNotifier();
    const createTaskMock = vi.fn(async () => ({ id: `task-${scenario.patientId}`, resourceType: 'Task' }));
    triageConsumer = new TriageConsumer(createTriageConsumerOptions(bus, queueNotifier, createTaskMock));
    await triageConsumer.start();

    const { asrClient, intentClassifier } = buildPlaybackClients([scenario]);
    const prompts: string[] = [];

    const ctx = applyTelephonyDependencies({
      id: scenario.callId,
      callId: scenario.callId,
      audioRef: scenario.audioRef,
      patientId: scenario.patientId,
      correlationId: scenario.correlationId,
      asrClient,
      intentClassifier,
      bus,
      metadata: { callerId: '+15551230000', practiceId: 'demo' },
      enqueuePrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      ivrPrompts: [],
      idempotencyStore: createIdempotencyStore(),
      intentConfidenceThreshold: 0.7,
    } as TelephonyContext);

    const callReceived = new CallReceivedState();
    let next = await callReceived.handle(ctx, { type: 'telephony.call.received' });
    expect(next).toBe('LanguageSelection');

    const languageSelection = new LanguageSelectionState();
    next = await languageSelection.handle(ctx, { type: 'telephony.language.selection' });
    expect(next).toBe('Transcribed');
    expect(ctx.availableLanguages?.length).toBeGreaterThan(0);
    expect(prompts.length).toBeGreaterThan(0);

    const transcribed = new TranscribedState();
    next = await transcribed.handle(ctx, { type: 'telephony.call.transcribed' });
    expect(next).toBe('IntentClassified');

    const intentClassified = new IntentClassifiedState();
    const finalState = await intentClassified.handle(ctx, { type: 'telephony.intent.classified' });
    expect(finalState).toBe('Routed');
    expect(ctx.intentRouteTarget).toBe('triage');
    expect(ctx.intentRoutingDecision).toBe('auto');
    expect(ctx.triageInput?.features?.intent).toBe(scenario.intent);
    expect(ctx.triageInput?.features?.channel).toBe('telephony');

    const routed = new RoutedState();
    await routed.handle(ctx, { type: 'telephony.call.routed' });

    expect(callEvents).toHaveLength(1);
    const callMessage = callEvents[0]!;
    expect(callMessage.headers?.['x-correlation-id']).toBe(scenario.correlationId);
    expect(callMessage.envelope.payload).toMatchObject({
      callId: scenario.callId,
      transcript: scenario.transcript,
      patientId: scenario.patientId,
    });

    expect(intentEvents).toHaveLength(1);
    const intentMessage = intentEvents[0]!;
    expect(intentMessage.headers?.['x-correlation-id']).toBe(scenario.correlationId);
    expect(intentMessage.envelope.payload).toMatchObject({
      callId: scenario.callId,
      intent: scenario.intent,
      confidence: scenario.confidence,
    });

    expect(triageEvents).toHaveLength(1);
    const triageMessage = triageEvents[0]!;
    expect(triageMessage.envelope.correlationId).toBe(scenario.correlationId);
    expect(triageMessage.envelope.payload).toMatchObject({
      patientId: scenario.patientId,
      narrative: scenario.transcript,
    });
    expect(triageMessage.envelope.payload.features?.intent).toBe(scenario.intent);
    expect(triageMessage.envelope.payload.features?.channel).toBe('telephony');

    expect(taskEvents).toHaveLength(1);
    const taskMessage = taskEvents[0]!;
    expect(taskMessage.envelope.correlationId).toBe(scenario.correlationId);
    expect(taskMessage.envelope.payload.patientId).toBe(scenario.patientId);
    expect(taskMessage.envelope.payload.priority).toMatch(/STAT|URGENT|SOON|ROUTINE/);

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(queueNotifier.deliveries).toHaveLength(1);
    expect(queueNotifier.deliveries[0]?.queue).toBeDefined();
  });

  it('forces emergency transfer path without leaking triage payloads', async () => {
    const scenario: TelephonyPlaybackScenario = {
      callId: 'call-tele-emergency',
      audioRef: 'memory://call-tele-emergency',
      patientId: 'patient-tele-999',
      transcript: 'Caller reports severe chest pain and trouble breathing',
      intent: 'telephony.emergency',
      confidence: 0.96,
      correlationId: 'corr-tele-emergency',
      language: 'en',
    };

    const callEvents: CapturedMessage<CallTranscribed>[] = [];
    const intentEvents: CapturedMessage<IntentClassified>[] = [];
    const triageEvents: CapturedMessage<TriageInput>[] = [];
    const taskEvents: CapturedMessage<TaskCreated>[] = [];

    await captureTopic(bus, Topics.telephony.callTranscribed, callEvents, subscriptions);
    await captureTopic(bus, Topics.telephony.intentClassified, intentEvents, subscriptions);
    await captureTopic(bus, Topics.triage.input, triageEvents, subscriptions);
    await captureTopic(bus, Topics.tasks.created, taskEvents, subscriptions);

    const { asrClient, intentClassifier } = buildPlaybackClients([scenario]);
    const prompts: string[] = [];

    const ctx = applyTelephonyDependencies({
      id: scenario.callId,
      callId: scenario.callId,
      audioRef: scenario.audioRef,
      patientId: scenario.patientId,
      correlationId: scenario.correlationId,
      asrClient,
      intentClassifier,
      bus,
      forceEmergencyTransfer: true,
      metadata: { callerId: '+15551239999', practiceId: 'demo' },
      enqueuePrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      ivrPrompts: [],
      idempotencyStore: createIdempotencyStore(),
      intentConfidenceThreshold: 0.8,
      emergencyTransferEnabled: true,
    } as TelephonyContext);

    const callReceived = new CallReceivedState();
    let next = await callReceived.handle(ctx, { type: 'telephony.call.received' });
    expect(next).toBe('LanguageSelection');

    const languageSelection = new LanguageSelectionState();
    next = await languageSelection.handle(ctx, { type: 'telephony.language.selection' });
    expect(next).toBe('Transcribed');

    const transcribed = new TranscribedState();
    next = await transcribed.handle(ctx, { type: 'telephony.call.transcribed' });
    expect(next).toBe('IntentClassified');

    const intentClassified = new IntentClassifiedState();
    next = await intentClassified.handle(ctx, { type: 'telephony.intent.classified' });
    expect(next).toBe('EmergencyTransfer');
    expect(ctx.intentRouteTarget).toBe('emergency');
    expect(ctx.intentRoutingDecision).toBe('emergency');
    expect(ctx.emergencyTransferTriggered).toBe(true);
    expect(ctx.triageInput).toBeUndefined();

    const emergencyTransfer = new EmergencyTransferState();
    const routedNext = await emergencyTransfer.handle(ctx, { type: 'telephony.intent.emergency_transfer' });
    expect(routedNext).toBe('Routed');
    expect(prompts.pop()).toBe('Connecting you to emergency services. Please stay on the line.');

    const routed = new RoutedState();
    await routed.handle(ctx, { type: 'telephony.call.routed' });

    expect(callEvents).toHaveLength(1);
    expect(intentEvents).toHaveLength(1);
    expect(triageEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(0);

    const intentPayload = JSON.stringify(intentEvents[0]!.envelope.payload);
    expect(intentPayload).not.toMatch(/chest pain|trouble breathing/i);
  });
});
