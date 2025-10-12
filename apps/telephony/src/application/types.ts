import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { MessageBus } from '@onecare/bus';
import type { TypedEnvelope, CallTranscribed } from '@onecare/events';
import type {
  AsrClient,
  CallTranscribedBuilder,
  TranscriptionResponse,
} from '../adapters/asr.client';
import type { CallMetadata } from '../adapters/ivr.adapter';

export interface TelephonyContext extends MachineContext {
  callId: string;
  audioRef?: string;
  metadata?: CallMetadata;
  patientId?: string | null;
  correlationId?: string;
  asrClient?: AsrClient;
  buildCallTranscribed?: CallTranscribedBuilder;
  bus?: MessageBus;
  transcription?: TranscriptionResponse;
  callTranscribed?: CallTranscribed;
  callTranscribedEnvelope?: TypedEnvelope<CallTranscribed>;
  callTranscribedPublishedAt?: number;
  now?: () => number;
}

export interface TelephonyEvent extends MachineEvent {
  type:
    | 'telephony.call.received'
    | 'telephony.call.transcribed'
    | 'telephony.intent.classified'
    | 'telephony.call.routed'
    | string;
}

