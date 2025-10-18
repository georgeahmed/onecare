Engineer: Backend 04

Role: Backend Engineer (Booking)
Stack: TypeScript, GP Connect, @onecare/ports

Responsibilities
- Booking service: Search → Selected → Booked → WrittenBack → Confirmed.
 - Enhanced Access windows; hold-back fraction; slot types

Initial Tasks
- Implement GP Connect adapter and conflict handling.
- Write-back Appointment to FHIR; emit booking.appointment.created.

Start Here
- Algorithm.md: 4) Booking (Local, PCN EA, GP Connect)
- Schemas: schemas/booking/booking-search-request.json, booking/appointment-created.json
- Config: config/nhs_gp_defaults.yaml (hold_back_fraction)

Contracts & Validation
- Define booking search/response and appointment-created schemas first; run codegen.
- Use Ajv to validate handler inputs/outputs; gate on contract tests.

Status: in progress
Progress: 90%

Dependencies
- integrations/engineer-02 (GP Connect)
- frontend/engineer-02 (Booking UI)
- integrations/engineer-01 (FHIR repo)

Platform Checklist (pre-flight)
- GP Connect sandbox endpoint reachable; TLS truststore/CA configured; auth keys/secrets mounted.
- FHIR repository port reachable with service account creds; write-back permissions granted.
- Bus durability (BE-02.4) and DLQ topics ready, if event-driven paths are enabled.
- Shared IdempotencyStore (Redis) configured for booking dedupe keys.
- Contract validation harness (Ajv) compiled and codegen wired into build for booking schemas.
- Observability base (logger auto correlationId; metrics/spans) available.
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks
- Completed items: see `team/backend/Completed Tasks/backend-engineer-04.md`.

Incomplete Tasks
- [ ] BE-04.15 — Additional documentation consolidations (ops runbook, future enhancements) — pending scoping.
