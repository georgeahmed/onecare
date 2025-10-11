ADR: Error Taxonomy and Envelopes

Status: Proposed
Date: 2025-10-11

Context
- We need consistent client-facing errors and safe messages across HTTP and events.

Decision
- Use `ErrorEnvelope` schema with codes: unauthorized, forbidden, invalid_input, unsupported_media_type, payload_too_large, conflict, too_many_requests, upstream_timeout, upstream_unavailable, invalid_fhir, busy, internal_error.
- Map codes to HTTP status in `mapErrorToStatus`; never include stack traces in bodies. Redact secrets in logs.

Consequences
- Predictable handling for clients and operators; safer logs.

