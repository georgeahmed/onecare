// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface PortalSubmission {
  practiceId: string;
  patient: {
    id: string;
    dob?: string;
    locale?: string;
    [k: string]: unknown;
  };
  narrative: string;
  attachments?: {
    contentType: string;
    url: string;
    [k: string]: unknown;
  }[];
  channel: "web" | "ivr";
}
