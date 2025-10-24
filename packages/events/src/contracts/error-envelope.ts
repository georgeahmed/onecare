// AUTO-GENERATED from schemas. DO NOT EDIT.

export type ErrorEnvelopeCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "unsupported_media_type"
  | "payload_too_large"
  | "conflict"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "internal_error"
  | "too_many_requests"
  | "rate_limited"
  | "busy"
  | "over_capacity"
  | "invalid_fhir";

export interface ErrorEnvelope {
  error: ErrorObject;
}
export interface ErrorObject {
  code: ErrorEnvelopeCode;
  message: string;
  details?: {
    [k: string]: unknown;
  };
  correlationId?: string;
}
