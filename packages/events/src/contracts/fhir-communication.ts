// AUTO-GENERATED from schemas. DO NOT EDIT.

export type FhirCommunicationStatus = "completed" | "in-progress" | "entered-in-error";

export interface FHIRCommunicationMinimal {
  resourceType: "Communication";
  status: FhirCommunicationStatus;
  topic?: FhirCommunicationTopic;
  subject?: FhirCommunicationSubject;
  medium?: FhirCommunicationMediumItem[];
  payload?: FhirCommunicationPayloadItem[];
  note?: FhirCommunicationNoteItem[];
  [k: string]: unknown;
}
export interface FhirCommunicationTopic {
  text?: string;
  [k: string]: unknown;
}
export interface FhirCommunicationSubject {
  reference?: string;
  [k: string]: unknown;
}
export interface FhirCommunicationMediumItem {
  [k: string]: unknown;
}
export interface FhirCommunicationPayloadItem {
  contentString?: string;
  [k: string]: unknown;
}
export interface FhirCommunicationNoteItem {
  text?: string;
  [k: string]: unknown;
}
