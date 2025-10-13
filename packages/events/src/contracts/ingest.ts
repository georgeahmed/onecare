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
  channel: "web" | "ivr";
}
