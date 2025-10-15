// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PortalSubmission {
  practiceId: string;
  patient: {
    id: string;
    dob?: string;
    locale?: string;
  };
  narrative: string;
  attachments?: {
    contentType: string;
    url: string;
  }[];
  interpreterPreferences?: {
    requiresInterpreter: boolean;
    /**
     * @minItems 1
     * @maxItems 3
     */
    preferredLanguages?: [string] | [string, string] | [string, string, string];
    notes?: string;
    requiresInterpreterConfirmed?: boolean;
  };
  channel: "web" | "ivr";
}
