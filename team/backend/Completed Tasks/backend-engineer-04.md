# Completed Tasks — Backend Engineer 04

- [x] **BE-04.1 — GP Connect client interface + env wiring**  
  Guarded GP Connect adapter with env-driven configuration in `apps/booking/src/adapters/gpconnect.client.ts:6`, including resilience wrappers (timeouts/circuit breaker) via `callWithGuard`. Behaviour validated in `apps/booking/test/gpconnect.client.test.ts:18`.
- [x] **BE-04.2 — booking.search handler skeleton**  
  Search state now validates contracts and produces schema-compliant responses in `apps/booking/src/application/booking.state.ts:76`, exercised by state and server tests (`apps/booking/test/booking.state.test.ts:130`, `apps/booking/test/server.test.ts:6`).
- [x] **BE-04.3 — Appointment create + conflict handling**  
  Booking flow handles conflicts, FHIR write-back with guardrails, and event emission in `apps/booking/src/application/booking.state.ts:238`; covered by integration tests `apps/booking/test/booking.state.test.ts:42`.
- [x] **BE-04.4 — Contract-first schemas + validators**  
  Added `booking-search-response` schema with generated TS/Py models, wired validators in `apps/booking/src/application/contracts.ts`, and documented usage in `docs/EVENTS.md` with contract tests at `apps/booking/test/contracts/booking.contract.test.ts:4`.
- [x] **BE-04.5 — Idempotent booking & 409 handling**  
  HTTP adapter enforces idempotency keys and returns 409 on duplicates via `apps/booking/src/index.ts:107`, with coverage in `apps/booking/test/server.test.ts:20` and sanitized logging in `apps/booking/src/application/booking.state.ts:301`.
- [x] **BE-04.10 — Health/readiness + graceful shutdown**  
  Implemented `/healthz` and `/readyz` endpoints with optional dependency checks in `apps/booking/src/index.ts:52`, ensuring readiness hooks for deployment wiring.
- [x] **BE-04.6 — DLQ and retry policy for booking events**  
  Appointment publish failures retry twice then emit DLQ envelopes with attempts metadata in `apps/booking/src/application/booking.state.ts:264`, validated by `apps/booking/test/booking.state.test.ts:451`.
- [x] **BE-04.7 — Outbound guardrails (GP Connect/FHIR)**  
  Added guardrails and SSRF/TLS checks around GP Connect and FHIR operations via `apps/booking/src/adapters/callWithGuard.ts:1` and `apps/booking/src/adapters/gpconnect.client.ts:94`, with SSRF coverage in `apps/booking/test/gpconnect.client.test.ts:118`.
- [x] **BE-04.8 — Observability (search/booking latency; spans; correlation)**  
  HTTP adapter records request latency/backpressure metrics in `apps/booking/src/index.ts:24`, while event metrics capture publish retries and DLQ counts in `apps/booking/src/application/booking.state.ts:115`.
- [x] **BE-04.9 — Backpressure & rate limits**  
  Implemented concurrency caps with 429 envelopes and telemetry in `apps/booking/src/index.ts:84`, surfaced in tests `apps/booking/test/server.test.ts:20`.
- [x] **BE-04.11 — Privacy/PII minimization**  
  Hashed patient identifiers across idempotency keys, logs, queue, and audit payloads in `apps/booking/src/application/booking.state.ts:512`, ensuring no raw PHI hits logs.
- [x] **BE-04.12 — Performance baselines**  
  Documented latency targets and metric usage in `apps/booking/README.md:9` alongside new histograms/counters.
- [x] **BE-04.13 — Fault injection tests**  
  Added DLQ failure simulation to confirm guarded retries in `apps/booking/test/booking.state.test.ts:451`.
- [x] **BE-04.14 — Documentation & ADRs**  
  Captured decisions in `docs/adr/2025-10-15-booking-dlq.md` and updated `docs/EVENTS.md:28` with DLQ metadata guidance.
