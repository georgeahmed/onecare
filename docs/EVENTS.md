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

Triage
- Ingress: `schemas/triage/triage-input.json` consumed by the triage application (Topics.triage.input).
- Egress: `schemas/triage/triage-decision.json` capturing scored outcomes and routing metadata (Topics.triage.decision).
- Egress: `schemas/tasks/task-created.json` for downstream task orchestration (Topics.tasks.created).
- Egress: `schemas/tasks/task-updated.json` for SLA escalations (Topics.tasks.updated).
- Documentation: `apps/triage/README.md`, ADRs `2025-10-18-triage-scoring-and-prioritization`, `2025-10-18-triage-dedup-similarity`, and `2025-10-18-triage-provider-assignment` describe scoring, dedup, assignment, and readiness guardrails in detail.
- Poison messages: triage consumers retry up to 3 times with exponential backoff+jitter; exhausted or non-retryable failures emit `DlqEvent` on `Topics.broker.deadLetter` containing only correlationId/error code/envelope metadata (no narratives). Operators can inspect `triage.retry` / `triage.dlq` metrics and follow the DLQ runbook to replay after remediation.

Codegen
- TS: json-schema-to-typescript via `npm run --workspaces=false codegen`
- Python: datamodel-code-generator via `RUN_PY=1 npm run --workspaces=false codegen`

DLQ
- DLQ envelope schema: `schemas/common/dlq-event.json` (DlqEvent)
- Keep DLQ payloads minimal and PHI-free; prefer `payloadRef`.
- Operators can replay DLQ items safely; see `infra/event-bus/dlq-runbook.md`.
- Use the orchestrator `publishWithRetry` helper when producing events so publishes wait for acks, retry with exponential backoff, emit `publish.ok` / `publish.retry` / `publish.fail` metrics (plus `publish.duration` histogram), and automatically route exhausted attempts to `Topics.broker.deadLetter` with validated `DlqEvent` payloads and stable `x-message-id` / `x-idempotency-key` headers.

Booking
- Search ingress must validate against `schemas/booking/booking-search-request.json`; responses serialize with `schemas/booking/booking-search-response.json`.
- The booking HTTP adapter publishes `Topics.booking.appointmentCreated` with payload `schemas/booking/appointment-created.json`; duplicates route to `Topics.booking.appointmentCreatedDlq`. Event publishing retries twice before DLQ and logs `booking_event_publish_error_total` / `booking_event_dlq_total`.
- Example publish (matches playback fixtures):
  ```ts
  const payload = {
    appointmentId: 'appt-200-1',
    patientId: 'patient-123',
    start: '2025-10-20T09:00:00Z',
    end: '2025-10-20T09:15:00Z',
    location: 'org-200',
  };
  const patientFingerprint = 'patient-hash-123'; // derived via booking.state hashIdentifier
  const envelope = createEnvelope(Topics.booking.appointmentCreated, payload, 'corr-playback');
  await bus.publish(envelope.topic, envelope, {
    'x-correlation-id': envelope.correlationId,
    'x-idempotency-key': `booking:${patientFingerprint}:slot-200-1:corr-playback`,
  });
  ```
- DLQ payloads include `attempts`, `errorCode`, and sanitized `payloadRef` metadata to aid replay without exposing PHI. See `schemas/common/dlq-event.json`.
- Deterministic fixtures in `fixtures/gpconnect/*.json` and `apps/booking/test/gpconnect.playback.test.ts` exercise the booking envelopes offline; update them when the contract changes.
- Assisted outcomes emit `Topics.booking.assistedCompleted` envelopes (schema `schemas/booking/assisted-outcome.json`) whenever staff confirm or decline slots manually. Payloads include taskId, patientId, outcome (`booked`, `no_time`, `pharmacy_referral_sent`), optional Appointment reference, and staff audit metadata.

Pharmacy
- Router ingress validates against `schemas/pharmacy/pharmacy-referral.json` before executing the state machine.
- Successful write-back emits `pharmacy.outcome` envelopes shaped by `schemas/pharmacy/pharmacy-outcome.json`; payloads contain only serviceRequest identifiers, organisation IDs, status, and recorded timestamps.
- Patient updates publish on `pharmacy.notification` with payloads conforming to `schemas/pharmacy/pharmacy-notification.json` (length-capped summaries, consent aware).
- Always create envelopes via `createEnvelope(topic, payload, correlationId)` and include the referral idempotency key in the `x-idempotency-key` header to dedupe downstream consumers.

Messaging — GP Connect Send Document
- HTTP ingress validates against `schemas/messaging/send-document-request.json` and maps to `Topics.messaging.sendDocRequested` with payload `schemas/messaging/send-document-requested.json` (taskId, patient reference, PDF location, Composition bundle reference, requestedAt).
- Successful dispatch publishes `Topics.messaging.sendDocSent` envelopes conforming to `schemas/messaging/send-document-sent.json` (messageId, mexTo, mexWorkflowId, mexLocalId, sentAt, ack scheduling metadata).
- ACK/NACK/retry schemas (`schemas/messaging/send-document-ack.json`, `...-nack.json`, `...-retry.json`) reserve structure for downstream consumers processing MESH responses or scheduling retries; ensure future handlers validate and emit via the same helpers.
