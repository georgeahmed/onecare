import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { MessageBus } from '@onecare/bus';
import type { TypedEnvelope, CallTranscribed, IntentClassified } from '@onecare/events';
import type {
  AsrClient,
  CallTranscribedBuilder,
  TranscriptionResponse,
} from '../adapters/asr.client';
import type {
  IntentClassificationInput,
  IntentClassificationResult,
  IntentClassifier,
} from '../adapters/intent.classifier';
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
  intentClassificationInput?: IntentClassificationInput;
  intentClassifier?: IntentClassifier;
  intentClassificationResult?: IntentClassificationResult;
  intentClassified?: IntentClassified;
  intentClassifiedEnvelope?: TypedEnvelope<IntentClassified>;
  intentClassifiedPublishedAt?: number;
  intentConfidenceThreshold?: number;
  intentRoutingDecision?: IntentRoutingDecision;
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

export type {
  IntentClassificationInput,
  IntentClassificationResult,
  IntentClassifier,
} from '../adapters/intent.classifier';

export type IntentRoutingDecision = 'auto' | 'fallback';
