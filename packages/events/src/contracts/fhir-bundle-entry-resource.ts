// AUTO-GENERATED from schemas. DO NOT EDIT.

export type FHIRBundleEntryResource = BundleEntryPatient | BundleEntryCommunication | BundleEntryDocumentReference;
export type BundleEntryPatient = FHIRPatientMinimal & {
  resourceType?: "Patient";
  [k: string]: unknown;
};
export type BundleEntryCommunication = FHIRCommunicationMinimal & {
  resourceType?: "Communication";
  [k: string]: unknown;
};
export type FhirCommunicationStatus = "completed" | "in-progress" | "entered-in-error";
export type BundleEntryDocumentReference = FHIRDocumentReferenceMinimal & {
  resourceType?: "DocumentReference";
  [k: string]: unknown;
};
export type FhirDocumentReferenceStatus = "current" | "superseded" | "entered-in-error";

export interface FHIRPatientMinimal {
  resourceType: "Patient";
  id: string;
  [k: string]: unknown;
}
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
export interface FHIRDocumentReferenceMinimal {
  resourceType: "DocumentReference";
  status: FhirDocumentReferenceStatus;
  subject?: FhirDocumentReferenceSubject;
  /**
   * @minItems 1
   */
  content: [FhirDocumentReferenceContentItem, ...FhirDocumentReferenceContentItem[]];
  [k: string]: unknown;
}
export interface FhirDocumentReferenceSubject {
  reference?: string;
  [k: string]: unknown;
}
export interface FhirDocumentReferenceContentItem {
  attachment: FhirDocumentReferenceAttachment;
  [k: string]: unknown;
}
export interface FhirDocumentReferenceAttachment {
  url: string;
  contentType: string;
  [k: string]: unknown;
}
