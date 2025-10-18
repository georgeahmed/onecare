Engineer: Backend 05

Role: Backend Engineer (Pharmacy Router)
Stack: TypeScript, CPCS, @onecare/ports

Responsibilities
- Eligibility rules; CPCS referral (slot/slotless); outcome write-back.
 - Minor ailments classification; patient notification; escalation back to GP if needed.

Initial Tasks
- Implement CPCS adapter; send referrals; notify patient.
- Write back ServiceRequest and outcomes to FHIR.

Start Here
- Algorithm.md: 5) Pharmacy First Router
- Schemas: schemas/pharmacy/pharmacy-referral.json
- Topics: packages/events/src/topics.ts (pharmacy.*)

Contracts & Validation
- Contract-first for pharmacy.referral/pharmacy.outcome; run codegen.
- Ajv-based validators in tests for payloads and DLQ entries.

Status: completed
Progress: 100%

Dependencies
- integrations/engineer-03 (CPCS)
- integrations/engineer-01 (FHIR repo)
- frontend/engineer-02 (Notifications/UX copy)

Platform Checklist (pre-flight)
- CPCS endpoint reachable; TLS truststore/CA configured; auth keys/secrets mounted; outbound host allowlisted.
- FHIR repository port reachable with service account creds for ServiceRequest/outcomes.
- Bus durability (BE-02.4) with DLQ topics, if events used.
- Shared IdempotencyStore (Redis) for referral/outcome dedupe keys.
- Contract validation harness (Ajv) and codegen integrated.
- Observability base (logger auto correlationId; counters/timers; spans).
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks
- All tasks archived in `team/backend/Completed Tasks/engineer-05.md`.
