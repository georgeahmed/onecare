// AUTO-GENERATED from schemas. DO NOT EDIT.

export type PortalSubmissionChannel = "web" | "ivr";

export interface PortalSubmission {
  practiceId: string;
  patient: PortalSubmissionPatient;
  narrative: string;
  attachments?: PortalSubmissionAttachment[];
  interpreterPreferences?: PortalSubmissionInterpreterPreferences;
  channel: PortalSubmissionChannel;
}
export interface PortalSubmissionPatient {
  id: string;
  dob?: string;
  locale?: string;
}
export interface PortalSubmissionAttachment {
  contentType: string;
  url: string;
}
export interface PortalSubmissionInterpreterPreferences {
  requiresInterpreter: boolean;
  /**
   * @minItems 1
   * @maxItems 3
   */
  preferredLanguages?: [string] | [string, string] | [string, string, string];
  notes?: string;
  requiresInterpreterConfirmed?: boolean;
}
