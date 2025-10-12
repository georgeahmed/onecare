import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { MessageBus } from '@onecare/bus';
import type { TypedEnvelope, CallTranscribed, IntentClassified, TriageInput } from '@onecare/events';
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
import type { EmergencyHandoffDetails } from '../adapters/emergency.handoff';

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
  availableLanguages?: string[];
  selectedLanguage?: string;
  languagePromptSelections?: LanguagePromptSelection[];
  intentRoutingDecision?: IntentRoutingDecision;
  intentRouteTarget?: IntentRouteTarget;
  intentRouteReason?: string;
  triageInput?: TriageInput;
  triageInputEnvelope?: TypedEnvelope<TriageInput>;
  triageInputPublishedAt?: number;
  callbackWindowOptions?: CallbackWindowOptions;
  emergencyTransferEnabled?: boolean;
  emergencyTransferTriggered?: boolean;
  emergencyTransferAt?: number;
  forceEmergencyTransfer?: boolean;
  emergencyHandoffAt?: number;
  emergencyHandoff?: (details: EmergencyHandoffDetails) => Promise<void> | void;
  ivrPrompts?: string[];
  enqueuePrompt?: (prompt: string) => Promise<void> | void;
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

export type IntentRoutingDecision = 'auto' | 'fallback' | 'emergency';
export type IntentRouteTarget = 'triage' | 'admin' | 'pharmacy' | 'billing' | 'emergency';
export type CallbackPriority = 'stat' | 'urgent' | 'soon' | 'routine';

export interface CallbackWindowOptions {
  priority: CallbackPriority;
  windowCode: string;
  windowLabel: string;
}

export interface LanguagePromptSelection {
  code: string;
  promptKey: string;
  digit: number;
}

export type { EmergencyHandoffDetails };
