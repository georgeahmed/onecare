import type {
  PortalSubmission as ContractPortalSubmission,
  SafetyDecision as ContractSafetyDecision,
  ErrorEnvelope as ContractErrorEnvelope,
  GuidedHelpSessionRequest as ContractGuidedHelpSessionRequest,
  GuidedHelpSessionResponse as ContractGuidedHelpSessionResponse,
} from '@onecare/events';

export type PortalSubmission = ContractPortalSubmission;
export type SafetyDecision = ContractSafetyDecision;
export type ErrorEnvelope = ContractErrorEnvelope;
export type GuidedHelpSessionRequest = ContractGuidedHelpSessionRequest;
export type GuidedHelpSessionResponse = ContractGuidedHelpSessionResponse;
export type PortalChannel = PortalSubmission['channel'];
export type PortalPatient = PortalSubmission['patient'];

type AttachmentArray = NonNullable<PortalSubmission['attachments']>;
export type PortalSubmissionAttachment = AttachmentArray extends Array<infer Item> ? Item : never;
