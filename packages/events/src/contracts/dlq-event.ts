// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface DlqEvent {
  originalTopic: string;
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
  /**
   * Opaque reference or small safe context; avoid PHI.
   */
  payloadRef?:
    | {
        [k: string]: unknown;
      }
    | string;
  ts: string;
}
