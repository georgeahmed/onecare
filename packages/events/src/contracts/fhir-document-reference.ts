// AUTO-GENERATED from schemas. DO NOT EDIT.

export type FhirDocumentReferenceStatus = "current" | "superseded" | "entered-in-error";

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
