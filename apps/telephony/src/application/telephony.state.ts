import { BaseState } from '@onecare/statekit';
import { logger } from '@onecare/observability';
import { Topics, createEnvelope } from '@onecare/events';
import { buildCallTranscribed } from '../adapters/asr.client';
import { buildIntentClassifiedEvent } from '../adapters/intent.classifier';
import type {
  TelephonyContext,
  TelephonyEvent,
  IntentClassificationInput,
  IntentRoutingDecision,
} from './types';

function sanitizePatientId(raw: string | null | undefined): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.55;

function normalizeConfidenceThreshold(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return 0;
    if (raw >= 1) return 1;
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return normalizeConfidenceThreshold(parsed);
  }
  return undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function resolveIntentConfidenceThreshold(explicit?: number): number {
  const normalized = normalizeConfidenceThreshold(explicit);
  if (normalized !== undefined) return normalized;
  const env = normalizeConfidenceThreshold(process.env.TELEPHONY_INTENT_CONFIDENCE_THRESHOLD);
  if (env !== undefined) return env;
  return DEFAULT_INTENT_CONFIDENCE_THRESHOLD;
}

function ensureIntentConfidenceThreshold(ctx: TelephonyContext): number {
  const resolved = resolveIntentConfidenceThreshold(ctx.intentConfidenceThreshold);
  ctx.intentConfidenceThreshold = resolved;
  return resolved;
}

function ensureEmergencyTransferEnabled(ctx: TelephonyContext): boolean {
  if (typeof ctx.emergencyTransferEnabled === 'boolean') {
    return ctx.emergencyTransferEnabled;
  }
  const envOverride = parseBooleanFlag(process.env.TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  if (envOverride !== undefined) {
    ctx.emergencyTransferEnabled = envOverride;
    return envOverride;
  }
  const configDefault = parseBooleanFlag(process.env.NHS_GP_TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  const resolved = configDefault !== undefined ? configDefault : true;
  ctx.emergencyTransferEnabled = resolved;
  return resolved;
}

function buildIntentClassificationInput(
  payload: { callId: string; transcript: string; lang?: string | null; patientId?: string | null },
  correlationId?: string,
): IntentClassificationInput {
  return {
    callId: payload.callId,
    transcript: payload.transcript,
    lang: payload.lang ?? null,
    patientId: payload.patientId ?? null,
    correlationId,
  };
}

export class CallReceivedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('CallReceived');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }
    ctx.callId = callId;
    ctx.id = callId;

    const audioRef = ctx.audioRef?.trim();
    if (!audioRef) {
      throw new Error('audio_ref_missing');
    }
    ctx.audioRef = audioRef;

    if (!ctx.asrClient) {
      throw new Error('asr_client_missing');
    }

    if (!ctx.intentClassifier) {
      throw new Error('intent_classifier_missing');
    }

    ctx.buildCallTranscribed = ctx.buildCallTranscribed ?? buildCallTranscribed;
    ctx.patientId = sanitizePatientId(ctx.patientId);
    ensureIntentConfidenceThreshold(ctx);
    ensureEmergencyTransferEnabled(ctx);

    if (ctx.metadata?.callerId) {
      ctx.metadata = {
        ...ctx.metadata,
        callerId: ctx.metadata.callerId.trim(),
      };
    }

    return 'Transcribed';
  }
}

export class TranscribedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('Transcribed');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const asrClient = ctx.asrClient;
    if (!asrClient) {
      throw new Error('asr_client_missing');
    }

    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }

    const audioRef = ctx.audioRef?.trim();
    if (!audioRef) {
      throw new Error('audio_ref_missing');
    }

    const builder = ctx.buildCallTranscribed ?? buildCallTranscribed;
    ctx.buildCallTranscribed = builder;

    const transcription = await asrClient.transcribe(callId, audioRef);
    ctx.transcription = transcription;

    const payload = builder({
      callId,
      transcription,
      context: ctx.patientId !== undefined ? { patientId: ctx.patientId } : undefined,
    });

    ctx.callTranscribed = payload;

    const envelope = createEnvelope(Topics.telephony.callTranscribed, payload, ctx.correlationId);
    ctx.callTranscribedEnvelope = envelope;
    ctx.intentClassificationInput = buildIntentClassificationInput(payload, ctx.correlationId);
    ensureIntentConfidenceThreshold(ctx);
    ensureEmergencyTransferEnabled(ctx);

    const bus = ctx.bus;
    if (!bus) {
      throw new Error('message_bus_missing');
    }

    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    try {
      await bus.publish(Topics.telephony.callTranscribed, envelope, headers);
    } catch (error) {
      logger.error('telephony.call.transcribed.publish_failed', {
        callId,
        correlationId: ctx.correlationId,
        reason: (error as Error).message,
      });
      throw new Error('call_transcribed_publish_failed');
    }

    const nowFn = ctx.now ?? Date.now;
    ctx.callTranscribedPublishedAt = nowFn();

    logger.info('telephony.call.transcribed', {
      callId,
      correlationId: ctx.correlationId,
      lang: payload.lang ?? undefined,
      patientIdPresent: payload.patientId != null,
    });

    return 'IntentClassified';
  }
}

export class IntentClassifiedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('IntentClassified');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const input = ctx.intentClassificationInput;
    if (!input) {
      throw new Error('intent_input_missing');
    }

    const intentClassifier = ctx.intentClassifier;
    if (!intentClassifier) {
      throw new Error('intent_classifier_missing');
    }

    const bus = ctx.bus;
    if (!bus) {
      throw new Error('message_bus_missing');
    }

    const result = await intentClassifier.classify(input);
    ctx.intentClassificationResult = result;

    const payload = buildIntentClassifiedEvent(input, result);
    ctx.intentClassified = payload;
    const threshold = ensureIntentConfidenceThreshold(ctx);

    const confidence =
      typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined;
    const highConfidence = confidence !== undefined && confidence >= threshold;
    const decision: IntentRoutingDecision = highConfidence ? 'auto' : 'fallback';
    ctx.intentRoutingDecision = decision;
    const emergencyEnabled = ensureEmergencyTransferEnabled(ctx);
    const forcedTransfer = Boolean(ctx.forceEmergencyTransfer);
    const shouldTransfer = emergencyEnabled && (forcedTransfer || !highConfidence);
    ctx.emergencyTransferTriggered = shouldTransfer;
    if (!highConfidence) {
      logger.warn('telephony.intent.low_confidence', {
        callId: input.callId,
        confidence,
        threshold,
        intent: payload.intent,
        correlationId: ctx.correlationId,
      });
    }
    if (shouldTransfer) {
      ctx.intentRoutingDecision = 'emergency';
      logger.error('telephony.emergency_transfer.queued', {
        callId: input.callId,
        intent: payload.intent,
        confidence,
        correlationId: ctx.correlationId,
      });
    }

    const envelope = createEnvelope(Topics.telephony.intentClassified, payload, ctx.correlationId);
    ctx.intentClassifiedEnvelope = envelope;

    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    try {
      await bus.publish(Topics.telephony.intentClassified, envelope, headers);
    } catch (error) {
      logger.error('telephony.intent.classified.publish_failed', {
        callId: input.callId,
        intent: payload.intent,
        correlationId: ctx.correlationId,
        reason: (error as Error).message,
      });
      throw new Error('intent_classified_publish_failed');
    }

    const nowFn = ctx.now ?? Date.now;
    ctx.intentClassifiedPublishedAt = nowFn();

    logger.info('telephony.intent.classified', {
      callId: input.callId,
      intent: payload.intent,
      confidence: payload.confidence,
      correlationId: ctx.correlationId,
    });

    if (ctx.emergencyTransferTriggered && ctx.emergencyTransferEnabled) {
      return 'EmergencyTransfer';
    }
    return 'Routed';
  }
}

export class EmergencyTransferState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('EmergencyTransfer');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const nowFn = ctx.now ?? Date.now;
    ctx.emergencyTransferAt = nowFn();
    ctx.ivrPrompts = ctx.ivrPrompts ?? [];
    const prompt = 'Connecting you to emergency services. Please stay on the line.';
    ctx.ivrPrompts.push(prompt);
    logger.warn('telephony.ivr.prompt.emergency_transfer', {
      callId: ctx.callId,
      prompt,
      correlationId: ctx.correlationId,
    });
    logger.error('telephony.emergency_transfer.initiated', {
      callId: ctx.callId,
      intent: ctx.intentClassified?.intent ?? 'unknown',
      correlationId: ctx.correlationId,
    });
    return 'Routed';
  }
}

export class RoutedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('Routed');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    if (!ctx.intentClassified) {
      throw new Error('intent_classified_missing');
    }

    const decision = ctx.intentRoutingDecision ?? 'fallback';
    logger.debug('telephony.call.routed', {
      callId: ctx.intentClassified.callId,
      intent: ctx.intentClassified.intent,
      correlationId: ctx.correlationId,
      decision,
    });
    if (decision === 'emergency') {
      logger.error('telephony.routing.emergency_transfer', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        correlationId: ctx.correlationId,
      });
    } else if (decision === 'auto') {
      logger.info('telephony.routing.auto', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        confidence: ctx.intentClassified.confidence,
        correlationId: ctx.correlationId,
      });
    } else {
      logger.warn('telephony.routing.fallback', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        confidence: ctx.intentClassified.confidence,
        threshold: ctx.intentConfidenceThreshold,
        correlationId: ctx.correlationId,
      });
    }

    return 'Routed';
  }
}
