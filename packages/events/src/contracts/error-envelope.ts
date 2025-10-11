// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface ErrorEnvelope {
  error: ErrorObject;
}
export interface ErrorObject {
  code:
    | "unauthorized"
    | "forbidden"
    | "invalid_input"
    | "conflict"
    | "upstream_timeout"
    | "upstream_unavailable"
    | "internal_error"
    | "too_many_requests"
    | "busy"
    | "invalid_fhir";
  message: string;
  details?: {
    [k: string]: unknown;
  };
  correlationId?: string;
}
