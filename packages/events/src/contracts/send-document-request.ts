// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface SendDocumentRequest {
  taskId: string;
  pdfUrl: string;
  compositionBundleRef: string;
  correlationId?: string;
  metadata?: SendDocumentRequestMetadata;
}
export interface SendDocumentRequestMetadata {
  [k: string]: string;
}
