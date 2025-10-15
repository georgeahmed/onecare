Event & Schema Guidelines

Envelope
- Use `TypedEnvelope<T>` (an alias over generated `EventEnvelope`) for message typing, created via `createEnvelope(topic, payload, correlationId)`.
- Correlate flows by setting `correlationId` (HTTP header `x-correlation-id`).

Design
- Payloads small and explicit; `additionalProperties: false` by default.
- Stable identifiers present in payloads (e.g., taskId, appointmentId).
- Avoid PHI-heavy payloads; publish references/IDs, not full patient data.

Versioning
- `$id` contains semantic version hints; additive changes preferred.
- Breaking changes require new schema id/version; dual-publish during migration if needed.

Topics
- See `infra/event-bus/topics.md` and `packages/events/src/topics.ts`.

Codegen
- TS: json-schema-to-typescript via `npm run codegen`
- Python: datamodel-code-generator via `RUN_PY=1 npm run codegen`

DLQ
- DLQ envelope schema: `schemas/common/dlq-event.json` (DlqEvent)
- Keep DLQ payloads minimal and PHI-free; prefer `payloadRef`.
- Operators can replay DLQ items safely; see `infra/event-bus/dlq-runbook.md`.

Booking
- Search ingress must validate against `schemas/booking/booking-search-request.json`; responses serialize with `schemas/booking/booking-search-response.json`.
- The booking HTTP adapter publishes `Topics.booking.appointmentCreated` with payload `schemas/booking/appointment-created.json`; duplicates route to `Topics.booking.appointmentCreatedDlq`.
- Use `createEnvelope(Topics.booking.appointmentCreated, payload, correlationId)` after validating via `validateAppointmentCreatedEvent`.
