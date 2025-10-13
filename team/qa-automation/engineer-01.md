Engineer: QA Automation 01

Role: QA Automation Engineer (Contracts/E2E)
Stack: Jest/Vitest, Pytest, Postman/newman

Responsibilities
- Contract tests against schemas; end-to-end flows.

Initial Tasks
- Validate payloads vs schemas; orchestrate portal→orchestrator→triage→booking tests.

Start Here
- Schemas: schemas/* (treat as contracts)
- CI: .github/workflows/ci.yml (test stages)

Status: in-progress
Progress: 83%

Dependencies
- backend/engineer-01 (Orchestrator)
- backend/engineer-03 (Triage), backend/engineer-04 (Booking)
- frontend team (Portal UI)

Platform Checklist (pre-flight)
- Access to schema directories and codegen outputs; TS/Py validators available in test harness.
- Test environments available with stable endpoints; seeded/demo data as needed.
- CI runners provisioned with required tools (node/python/k6/postman).
- No PHI in test logs/artifacts; correlationId recorded for traceability.

Tasks
- [x] QA-01.1 — Schema validation harness for TS events (Ajv or similar)
- [x] QA-01.2 — Contract tests for triage.input, tasks.created, appointment.created
- [x] QA-01.3 — E2E test: portal submission → orchestrator → triage Task
- [x] QA-01.4 — E2E test: booking search/create write-back
- [x] QA-01.5 — OpenAPI validation for Python endpoints (expand CI script)
- [ ] QA-01.6 — Contract tests for pharmacy and ICS
 - [ ] QA-01.7 — Property-based and fuzz tests for contracts (boundary/randomized payloads)
 - [ ] QA-01.8 — E2E fault injection (timeouts, CB open, partial failures) with deterministic mocks
 - [ ] QA-01.9 — DLQ path verification (poison messages, retries bounded, minimal context)
 - [ ] QA-01.10 — Backpressure and rate limit tests (429/503 flows; retry-after)
 - [ ] QA-01.11 — Privacy/redaction tests (logs/events PHI-free; sensitive pattern scans)
 - [ ] QA-01.12 — CorrelationId propagation audit across HTTP→bus→services
 - [ ] QA-01.13 — Telephony parity E2E (call transcribed → intent → orchestrator)
 - [ ] QA-01.14 — Synthetic load smoke (light k6/newman) for key paths with budgets
 - [ ] QA-01.15 — Hermetic test env (compose profile; seed data; stable endpoints)
 - [ ] QA-01.16 — Flaky test detection and quarantine strategy in CI
 - [ ] QA-01.17 — Test data management (fixtures, anonymization, rotation policy)
 - [ ] QA-01.18 — Contract drift monitor (schema/codegen diff gates; snapshots)
 - [ ] QA-01.19 — Accessibility checks in E2E (axe) for critical flows
 - [ ] QA-01.20 — QA runbooks and coverage matrix (systems under test, scenarios)
 - [ ] QA-01.21 — DLQ reprocessing E2E (replay → success; idempotency; correlation)
 - [ ] QA-01.22 — System chaos drills (bus down, FHIR 5xx, CB open) with SLO checks
