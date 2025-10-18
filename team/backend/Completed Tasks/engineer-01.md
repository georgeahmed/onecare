# Completed Tasks — Backend Engineer 01

- [x] BE-01.1 — Add zero-trust gate (verify/auth/consent) plumbing (apps/orchestrator/src/application/orchestrator.state.ts:58, apps/orchestrator/test/securityGate.test.ts:79).
- [x] BE-01.2 — Load typed config + enforce floors/ceilings (apps/orchestrator/src/index.ts:123, packages/config/src/index.ts:480).
- [x] BE-01.3 — Publish `triage.input` envelope when safe (apps/orchestrator/src/application/orchestrator.state.ts:287, apps/orchestrator/test/triagePublish.test.ts:96).
- [x] BE-01.4 — Emit audit events on success/deny (apps/orchestrator/src/application/orchestrator.state.ts:19, apps/orchestrator/test/triagePublish.test.ts:131).
- [x] BE-01.5a — Error codes/types from schema + envelope helper (apps/orchestrator/src/application/error.ts:3, apps/orchestrator/test/error.test.ts:1).
- [x] BE-01.5b — Status mapping + HTTP handler wrapper (apps/orchestrator/src/application/error.ts:31, apps/orchestrator/src/index.ts:590).
- [x] BE-01.5c — Logging redaction + error metrics (apps/orchestrator/src/application/error.ts:61, apps/orchestrator/src/index.ts:605).
- [x] BE-01.5d — Tests + docs for error taxonomy (docs/ERRORS.md:21, apps/orchestrator/test/error.test.ts:19).
- [x] BE-01.6a — IdempotencyStore interface (reserve/commit/release) (apps/orchestrator/src/application/idempotency.ts:6, apps/orchestrator/test/idempotency.test.ts:64).
- [x] BE-01.6b — Key/header derivation + TTL config (apps/orchestrator/src/application/idempotency.ts:6, apps/orchestrator/src/index.ts:128).
- [x] BE-01.6c — 409 path + metrics/logs (race-safe) (apps/orchestrator/src/application/orchestrator.state.ts:121, apps/orchestrator/test/idempotency.test.ts:110).
- [x] BE-01.6d — Concurrency tests (sequential + parallel) (apps/orchestrator/test/idempotency.test.ts:141).
- [x] BE-01.7a — `normalizeToFhir` + fixtures (pure) (apps/orchestrator/src/application/normalize.ts:26, apps/orchestrator/src/application/normalize.test.ts:7).
- [x] BE-01.7b — HTTP edge schema validation (apps/orchestrator/src/index.ts:1311, apps/orchestrator/test/requestLimits.test.ts:110).
- [x] BE-01.7c — Profile validation hook + error mapping (apps/orchestrator/src/application/orchestrator.state.ts:225, apps/orchestrator/src/application/normalize.test.ts:54).
- [x] BE-01.7d — Wire FHIR upsert + audit + unit tests (apps/orchestrator/src/application/orchestrator.state.ts:243, apps/orchestrator/test/e2e/triage-flow.test.ts:125).
- [x] BE-01.8a — `callWithGuard` (timeout/retry/backoff) (apps/orchestrator/src/adapters/services/callWithGuard.ts:46, apps/orchestrator/test/callWithGuard.test.ts:9).
- [x] BE-01.8b — Circuit breaker (half-open) semantics (apps/orchestrator/src/adapters/services/callWithGuard.ts:66, apps/orchestrator/test/callWithGuard.test.ts:39).
- [x] BE-01.8c — Correlation propagation + metrics/OTel (apps/orchestrator/src/application/orchestrator.state.ts:287, apps/orchestrator/test/e2e/triage-flow.test.ts:145).
- [x] BE-01.8d — Safety fallback (`rules`) + budgets (apps/orchestrator/src/application/orchestrator.state.ts:139, apps/orchestrator/test/safetyFallback.test.ts:67).
- [x] BE-01.9 — Orchestrator state machine skeleton with guarded transitions (apps/orchestrator/src/application/orchestrator.machine.ts:16, apps/orchestrator/test/e2e/triage-flow.test.ts:125).
- [x] BE-01.10 — HTTP ingress hardening (schema validation, content-type, body limits) (apps/orchestrator/src/index.ts:590, apps/orchestrator/test/requestLimits.test.ts:110).
- [x] BE-01.11 — Observability end-to-end (OTel traces, metrics, correlation) (apps/orchestrator/src/index.ts:195, apps/orchestrator/src/adapters/persistence/fhir.repository.ts:16).
- [x] BE-01.12 — Security hardening (SSRF guard, attachment sanitisation) (apps/orchestrator/src/index.ts:283, apps/orchestrator/test/attachments.test.ts:72).
- [x] BE-01.13 — Audit ledger resiliency with buffered writes, bounded retries, and tests (apps/orchestrator/src/adapters/audit/index.ts:31, apps/orchestrator/test/auditAdapter.test.ts:5).
- [x] BE-01.15 — Contract compliance & codegen (Ajv validators + schema-driven types) (apps/orchestrator/src/application/validator.ts:13, scripts/codegen/generate.js:1).
- [x] BE-01.14 — Backpressure + time budgets with concurrency limiter + HTTP 503 surfaces (apps/orchestrator/src/index.ts:1030, apps/orchestrator/test/resilience.test.ts:118).
- [x] BE-01.16 — DLQ and retry policy for bus publishes (apps/orchestrator/src/application/orchestrator.state.ts:278, apps/orchestrator/test/resilience.test.ts:170).
- [x] BE-01.17 — Rate limiting & abuse protection with token bucket guard (apps/orchestrator/src/index.ts:1030, apps/orchestrator/test/resilience.test.ts:130).
- [x] BE-01.18 — Health/readiness reflects dependencies + graceful shutdown draining (apps/orchestrator/src/index.ts:1645, apps/orchestrator/test/resilience.test.ts:199).
- [x] BE-01.19 — Fault injection tests for backpressure, rate limit, DLQ, shutdown (apps/orchestrator/test/resilience.test.ts:1).
- [x] BE-01.20 — Privacy minimisation (hashed `patientRef` in logs/audits/DLQ) (apps/orchestrator/src/application/orchestrator.state.ts:20, apps/orchestrator/src/application/orchestrator.state.ts:278).
- [x] BE-01.21 — Performance baselines documented (docs/perf/orchestrator-baselines.md:1, make perf-orchestrator target).
- [x] BE-01.22 — Documentation & ADR updates for resilience/error handling (docs/adr/2025-10-16-orchestrator-resilience.md:1, apps/orchestrator/README.md:1, docs/USAGE.md:10).


Status: planned
Progress: 0%
