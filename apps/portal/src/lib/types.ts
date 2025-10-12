export type PortalChannel = 'web' | 'ivr';

export interface PortalSubmissionAttachment {
  contentType: string;
  url: string;
}

export interface PortalPatient {
  id: string;
  dob?: string;
  locale?: string;
}

export interface PortalSubmission {
  practiceId: string;
  patient: PortalPatient;
  narrative: string;
  attachments?: PortalSubmissionAttachment[];
  channel: PortalChannel;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  correlationId?: string;
}
