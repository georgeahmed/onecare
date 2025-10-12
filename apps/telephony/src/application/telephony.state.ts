import { BaseState } from '@onecare/statekit';
import { logger } from '@onecare/observability';
import { Topics, createEnvelope } from '@onecare/events';
import { buildCallTranscribed } from '../adapters/asr.client';
import type { TelephonyContext, TelephonyEvent } from './types';

function sanitizePatientId(raw: string | null | undefined): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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

    ctx.buildCallTranscribed = ctx.buildCallTranscribed ?? buildCallTranscribed;
    ctx.patientId = sanitizePatientId(ctx.patientId);

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

    const bus = ctx.bus;
    if (!bus) {
      throw new Error('message_bus_missing');
    }

    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    await bus.publish(Topics.telephony.callTranscribed, envelope, headers);

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

  async handle(): Promise<string> {
    return 'Routed';
  }
}

export class RoutedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('Routed');
  }

  async handle(): Promise<string> {
    return 'Routed';
  }
}

