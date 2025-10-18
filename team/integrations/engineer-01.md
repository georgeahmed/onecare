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

Status: completed
Progress: 100%

Dependencies
- backend/engineer-01 (Orchestrator)
- devops-sre/engineer-01 (Secrets/infra)
- qa-automation/engineer-01 (Contract tests)

Tasks
Completed tasks have moved to `team/integrations/Completed Tasks/engineer-01.md`.

- [x] IN-01.8 — Startup now validates HTTPS/non-local hosts for FHIR/Object Store configs (apps/orchestrator/src/index.ts:64).
- [x] IN-01.14 — Charset negotiation and response validation enforced for FHIR operations (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:320).
- [x] IN-01.16 — Object Store guidance captures redaction patterns; adapters avoid PHI in logs (docs/CONVENTIONS.md:55).
- [x] IN-01.17 — Orchestrator performance baselines logged for release readiness (docs/perf/orchestrator-baselines.md:1).
- [x] IN-01.18 — Contract-style resilience tests added for FHIR retries/circuit breaker and readiness probes (apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:38).
- [x] IN-01.19 — ADR documents hardened FHIR/Object Store/OIDC workflows (docs/adr/2025-10-16-fhir-object-store-oidc.md:1).
