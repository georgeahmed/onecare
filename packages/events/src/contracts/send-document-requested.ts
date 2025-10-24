// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface SendDocumentRequested {
  taskId: string;
  patientId: string;
  pdfUrl: string;
  compositionBundleRef: string;
  requestedAt: string;
  correlationId?: string;
}
