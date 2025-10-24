// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface EventEnvelope {
  id: string;
  topic: string;
  timestamp: string;
  payload:
    | {
        [k: string]: unknown;
      }
    | unknown[]
    | string
    | number
    | boolean
    | null;
  correlationId?: string;
  metadata?: EventEnvelopeMetadata;
}
export interface EventEnvelopeMetadata {
  attempt?: number;
  firstSeenAt?: string;
  [k: string]: unknown;
}
