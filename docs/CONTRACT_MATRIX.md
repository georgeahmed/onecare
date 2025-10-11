Contract Matrix — Cross-Service Validation Plan

Purpose
- Single place to define critical contracts and the minimal cross-checks QA/automation should run to prevent drift across services.

How To Use
- For each row below, provide: sample valid payload(s), negative cases, and a contract test that validates against JSON Schemas using the compiled validators.
- Run locally and in CI: `npm run codegen:check && npm test` (include contract tests). No network calls.

Contracts To Validate
- Orchestrator
  - Ingress: `schemas/ingest/portal-submission.json` → Validate HTTP body (compiled schema) in orchestrator.
  - Egress: envelope to `Topics.triage.input` (generated TS + schema). Cross-check that `createEnvelope` output matches `schemas/triage/triage-input.json`.
  - Errors: `schemas/common/error-envelope.json` for 4xx/5xx mapping.
- Access Gate
  - Egress: `schemas/portal/notify.json` for `Topics.portal.notify`. Validate idempotency key computation (minute-truncated timestamp).
- Triage
  - Ingress: `schemas/triage/triage-input.json` from bus.
  - Egress: `schemas/tasks/task-created.json` on successful Task creation; `tasks.updated` for SLA aging.
- Booking
  - Ingress: `schemas/booking/booking-search-request.json` for search handler.
  - Egress: `schemas/booking/appointment-created.json` after write-back.
- Pharmacy Router
  - Ingress: `schemas/pharmacy/pharmacy-referral.json` for referral.
  - Egress: `schemas/pharmacy/pharmacy-outcome.json` (if present) after outcome write-back.
- ICS Hub
  - Ingress: `schemas/ics/referral-request.json`.
  - Egress: `schemas/ics/referral-ack.json`.
- Common
  - Envelope: `schemas/common/event-envelope.json` for all published events.
  - DLQ: `schemas/common/dlq-event.json` for poison messages.

Cross-Checks (Examples)
- Envelope Shape: Construct envelopes with `createEnvelope(topic, payload, correlationId)` and assert they validate against `event-envelope.json` and the topic-specific schema.
- Idempotency Keys: For `portal.notify`, `triage.input`, and `tasks.created`, compute expected keys (e.g., stable natural keys or minute truncation) and assert stability across runs.
- Error Mapping: Trigger representative invalid inputs in unit tests; assert `error-envelope.json` shape and expected `code` → HTTP status mapping.
- Privacy: Ensure sample payloads used in tests contain no PHI/PII; verify redaction helper removes sensitive fields from logs.

Execution Notes
- Place tests near services under `apps/*/test` or a shared `tests/contracts/*` suite.
- Keep tests deterministic; use fixtures committed in `tests/fixtures/*`.
- Avoid network access; use fakes for ports/bus.

