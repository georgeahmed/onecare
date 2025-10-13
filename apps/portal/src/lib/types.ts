import type {
  PortalSubmission as ContractPortalSubmission,
  SafetyDecision as ContractSafetyDecision,
  ErrorEnvelope as ContractErrorEnvelope,
} from '@onecare/events';

export type PortalSubmission = ContractPortalSubmission;
export type SafetyDecision = ContractSafetyDecision;
export type ErrorEnvelope = ContractErrorEnvelope;
export type PortalChannel = PortalSubmission['channel'];
export type PortalPatient = PortalSubmission['patient'];

type AttachmentArray = NonNullable<PortalSubmission['attachments']>;
export type PortalSubmissionAttachment = AttachmentArray extends Array<infer Item> ? Item : never;
