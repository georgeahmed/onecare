// AUTO-GENERATED from schemas. DO NOT EDIT.\n

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
}
