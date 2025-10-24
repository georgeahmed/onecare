ADR: Error Taxonomy and Envelopes

Status: Proposed
Date: 2025-10-11

Context
- We need consistent client-facing errors and safe messages across HTTP and events.

Decision
- Use `ErrorEnvelope` schema with codes: unauthorized, forbidden, invalid_input, not_found, unsupported_media_type, payload_too_large, conflict, too_many_requests, rate_limited, upstream_timeout, upstream_unavailable, busy, over_capacity, invalid_fhir, internal_error.
- Expose helpers in `@onecare/events` to build envelopes and translate codes to HTTP status; services re-export locally where needed. Never include stack traces in bodies. Redact secrets in logs.

Consequences
- Predictable handling for clients and operators; safer logs.
