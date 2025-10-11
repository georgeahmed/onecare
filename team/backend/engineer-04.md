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

Status: planned
Progress: 0%

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
- [ ] BE-04.1 — GP Connect client interface + env wiring (timeouts/retries/circuit breaker; TLS; auth)
- [ ] BE-04.4 — Contract-first: booking search request/response and appointment-created schemas; codegen + validators + contract tests
- [ ] BE-04.2 — booking.search handler (validation, paging, filtering)
- [ ] BE-04.3 — Appointment create + conflict handling (idempotent booking; retry-safe; FHIR write-back)
- [ ] BE-04.5 — Idempotent booking & dedupe (natural booking key; prevent double-book; exactly-once publish)
- [ ] BE-04.6 — DLQ and retry policy for booking events (bounded retries; poison quarantine; requeue guidance)
- [ ] BE-04.7 — Outbound guardrails (GP Connect/FHIR): timeout/retry/jitter/circuit breaker; SSRF allowlist; TLS; correlationId
- [ ] BE-04.8 — Observability (search/booking latency histograms; success/error/conflict rates; spans; correlation propagation)
- [ ] BE-04.9 — Backpressure & rate limits (concurrency caps per practice; 429/503 envelopes; metrics)
- [ ] BE-04.10 — Health/readiness + graceful shutdown (GP Connect/FHIR checks; drain inflight)
- [ ] BE-04.11 — Privacy/PII minimization (no PHI in events/logs; minimal payloads)
- [ ] BE-04.12 — Performance baselines (p50/p95 search/booking; throughput; budgets)
- [ ] BE-04.13 — Fault injection tests (conflicts, timeouts, partial failures; idempotency + fallback verified)
- [ ] BE-04.14 — Documentation & ADRs (booking architecture, conflict semantics, contracts, ops)
