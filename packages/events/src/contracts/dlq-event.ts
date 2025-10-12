// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface DlqEvent {
  originalTopic: string;
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
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
