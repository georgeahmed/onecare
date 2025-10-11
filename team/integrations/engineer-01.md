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
Progress: 57%

Dependencies
- backend/engineer-01 (Orchestrator)
- devops-sre/engineer-01 (Secrets/infra)
- qa-automation/engineer-01 (Contract tests)

Tasks
- [ ] IN-01.1 — FHIR client skeleton + env wiring (baseUrl, auth)
- [x] IN-01.2 — Bundle upsert (transaction) with retry/timeout
- [x] IN-01.3 — Create methods: Task, Appointment, DocumentReference
- [ ] IN-01.4 — Object Store linking for Binary/DocumentReference
- [ ] IN-01.5 — OIDC (NHS Login) client + consent check stub API
- [x] IN-01.6 — YAML config loader merge + floors/ceilings
- [x] IN-01.7 — FHIR profile validate() stub
 - [ ] IN-01.8 — SSRF guardrails & TLS enforcement (FHIR/Object Store)
 - [ ] IN-01.9 — Circuit breaker + backoff policy (idempotent-safe retries)
 - [ ] IN-01.10 — Idempotent FHIR ops (ETag/If-Match, 409/412 handling)
 - [ ] IN-01.11 — FHIR search/pagination helpers (429 Retry-After handling)
 - [ ] IN-01.12 — Observability (correlationId, metrics, spans; PHI-safe logs)
 - [ ] IN-01.13 — Health/readiness probes (FHIR/Object Store/OIDC); cached checks
 - [ ] IN-01.14 — Contract & content negotiation (application/fhir+json; Bundle.transaction)
 - [ ] IN-01.15 — OIDC JWT verify with JWKs rotation (kid/aud/iss/nbf/exp; skew)
 - [ ] IN-01.16 — Privacy & PHI minimization (payload shaping; audit-safe)
 - [ ] IN-01.17 — Performance baselines (p50/p95; keep-alive; connection reuse)
 - [ ] IN-01.18 — Fault injection tests (timeouts, CB-open, 429/backoff)
 - [ ] IN-01.19 — Documentation & ADRs (FHIR repo integration, consent/security)
