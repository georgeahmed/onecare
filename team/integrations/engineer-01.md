Engineer: Integrations 01

Role: Integration Engineer (FHIR)
Stack: FHIR REST, TypeScript, @onecare/ports

Responsibilities
- FHIR repository concrete implementation (bundle upsert, Task, Appointment, DocumentReference, Binary/ObjectStore refs).
- Identity/Consent integration (OIDC/NHS Login) and consent checks API.

Initial Tasks
- Implement FHIR client; add retries/timeout; validate profiles.
- Integrate Object Store for Binary/DocumentReference refs.
- Implement OIDC client for NHS Login; consent store API.

Start Here
- Algorithm.md: 0.2 FHIR-first, 11) Identity/Authorization/Consent, 12) Security
- Ports: packages/ports/src/fhir.ts, object-store.ts
- Security: packages/security/src/index.ts (authorize/consent)

Status: in-progress
Progress: 21%

Dependencies
- backend/engineer-01 (Orchestrator)
- devops-sre/engineer-01 (Secrets/infra)
- qa-automation/engineer-01 (Contract tests)

Tasks
Completed tasks have moved to `team/integrations/Completed Tasks/engineer-01.md`.

Incomplete
- [ ] IN-01.1 — HttpFhirRepository still lacks GET/logging support; the request helper only allows POST/PUT and no logger is wired in (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:184).
- [ ] IN-01.4 — DocumentReference helper forwards payloads without staging Binary content in an ObjectStore (packages/ports/src/fhir.ts:102, packages/ports/src/object-store.ts:1).
- [ ] IN-01.5 — OIDC/NHS Login client and consent stub API are unimplemented; the security package exposes only interfaces (packages/security/src/index.ts:1).
- [ ] IN-01.8 — Startup wiring accepts any FHIR_BASE_URL and no object store client, so SSRF/TLS guardrails remain TODO (apps/orchestrator/src/index.ts:58).
- [ ] IN-01.9 — The FHIR adapter retries with jitter but lacks a circuit breaker or capped retry policy abstraction (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:177).
- [ ] IN-01.10 — Idempotent operations (If-Match/ETag, 409/412 handling) are not implemented in the request pipeline (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:177).
- [ ] IN-01.11 — The repository contract omits search/pagination helpers and Retry-After handling for 429s (packages/ports/src/fhir.ts:22).
- [ ] IN-01.12 — Metrics/spans exist but the adapter does not emit PHI-safe structured logs via the shared logger (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:1, packages/observability/src/logger.ts:1).
- [ ] IN-01.13 — `/health` and `/ready` endpoints do not probe FHIR/Object Store/OIDC dependencies yet (apps/orchestrator/src/index.ts:1000).
- [ ] IN-01.14 — Request headers lack charset negotiation and no response validation hook asserts FHIR JSON envelopes (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:209).
- [ ] IN-01.15 — JWT verification and JWKS rotation for NHS Login remain unimplemented (packages/security/src/index.ts:1).
- [ ] IN-01.16 — Redaction helpers are unused around FHIR/Object Store flows and audit payload shaping is unspecified (packages/observability/src/logger.ts:1, apps/orchestrator/src/application/normalize.ts:26).
- [ ] IN-01.17 — No performance baselines or connection reuse controls are documented; release readiness keeps the FHIR/Object Store SLA gate unchecked (docs/RELEASE_READINESS.md:45).
- [ ] IN-01.18 — Test coverage stops at basic validation helpers; there is no resilience suite for timeouts/429/circuit-breaker scenarios (packages/ports/test/fhir.test.ts:1).
- [ ] IN-01.19 — There is no ADR or documentation covering the FHIR/Object Store/OIDC integration yet (docs/RELEASE_READINESS.md:45).
