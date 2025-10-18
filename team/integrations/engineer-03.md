Engineer: Integrations 03

Role: Integration Engineer (CPCS / ICS)
Stack: CPCS, ICS APIs, TypeScript

Responsibilities
- CPCS referrals; ICS broker requests/acks routing; billing interfaces if required.

Initial Tasks
- Implement CPCS client; ICS referral request/ack flows.

Start Here
- Algorithm.md: 5) Pharmacy First Router, 9) ICS Hub
- Topics: packages/events/src/topics.ts (pharmacy.*, ics.*)
 - Schemas: schemas/ics/referral-request.json, schemas/ics/referral-ack.json
 - Observability: packages/observability/src/logger.ts, src/otel.ts
 - Security: docs/CONVENTIONS.md (SSRF, redaction), docs/STABLE_BACKEND_CHECKLIST.md

Status: stable
Progress: 100%

Dependencies
- backend/engineer-05 (Pharmacy router)
- backend/engineer-07 (ICS hub)
- devops-sre/engineer-01 (Network/IAM)

Platform Checklist (pre-flight)
- External endpoints & credentials registered in config; secrets available via env/secret store (no plaintext in code).
- Bus durability (BE-02.4) and DLQ topics configured for ICS flows.
- Contract validation harness (Ajv) and codegen ready for ICS schemas.
- Observability base (logger auto correlationId; metrics/spans) available.

Tasks
- [x] IN-03.1 — CPCS client interface skeleton (typed, env/config wiring)
- [x] IN-03.2 — CPCS referral flow (timeouts/retries/jitter/CB; slotless fallback; error mapping)
- [x] IN-03.3 — ICS referral/ack client (TLS/auth; route mapping; ack semantics)
- [x] IN-03.4 — Billing interface placeholder (Claim/Response; TLS/auth; timeouts)
- [x] IN-03.5 — Observability for CPCS/ICS (structured logs, latency histograms, error counters, spans)
- [x] IN-03.6 — ICS org→endpoint map and routing policy (allowlist; per-org limits)
- [x] IN-03.7 — Security & SSRF guardrails (CPCS/ICS) — HTTPS + private-IP blocks mirrored for ICS with tests (`apps/ics-hub/src/adapters/ics.client.ts:676`, `apps/ics-hub/test/ics.client.test.ts:128`).
- [x] IN-03.8 — Contract-first ICS mapping (schemas/codegen; compiled validators; contract tests)
- [x] IN-03.9 — Idempotency & dedupe (external call keys; suppress duplicate referrals/acks)
- [x] IN-03.10 — DLQ and retry policy for ICS events (bounded retries; poison quarantine; minimal context)
- [x] IN-03.11 — Health/readiness and graceful shutdown (client health; drain inflight)
- [x] IN-03.12 — Fault injection tests (timeouts, partial failures, CB open, retries → DLQ)
- [x] IN-03.13 — Performance baselines (p50/p95 call latency; budgets; soak) — Perf harnesses pin ≤20 ms averages and histogram coverage (`apps/pharmacy-router/test/cpcs.perf.test.ts:18`, `apps/ics-hub/test/ics.perf.test.ts:24`).
- [x] IN-03.14 — Privacy/PII minimization (no PHI in logs/events; redaction by default)
- [x] IN-03.15 — Credential management & rotation readiness — Runtime refresh hooks with coverage for rotated headers and TLS updates (`apps/pharmacy-router/src/adapters/cpcs.client.ts:340`, `apps/pharmacy-router/test/cpcs.client.test.ts:190`, `apps/ics-hub/src/adapters/ics.client.ts:327`, `apps/ics-hub/test/ics.client.test.ts:190`).
- [x] IN-03.16 — Documentation & ADRs (CPCS/ICS integration design, error mapping, ops) — README updates + integration ADR capturing guardrails (`apps/pharmacy-router/README.md:65`, `apps/ics-hub/README.md:13`, `docs/adr/2025-10-13-cpcs-ics-integration.md:1`).
 - [x] IN-03.17 — API version/content negotiation (CPCS/ICS headers; Accept/Content-Type) — Default Accept headers ensured with regression tests (`apps/pharmacy-router/src/adapters/cpcs.client.ts:504`, `apps/billing/test/billing.client.test.ts:31`, `apps/ics-hub/test/ics.client.test.ts:81`).
 - [x] IN-03.18 — Credential/cert rotation readiness (OAuth/mTLS refresh; hot-reload) — Route refresh updates TLS bundles in-place (`apps/ics-hub/src/adapters/ics.client.ts:296`, `apps/ics-hub/test/ics.client.test.ts:204`).
 - [x] IN-03.19 — Sandbox playback harness (ICS/CPCS deterministic fixtures; offline CI) — Fixtures + harness with verification tests (`apps/ics-hub/src/dev/sandbox.ts:28`, `apps/ics-hub/test/sandbox.test.ts:7`).
 - [x] IN-03.20 — Adapter-level rate limits/backpressure (per-org caps; 429/503 mapping)
 - [x] IN-03.21 — Billing contracts & validators (Claim/Response schemas; codegen; DLQ) — Billing schemas, validators, and guarded bus publisher with tests (`schemas/billing/claim.json:1`, `apps/billing/src/adapters/contracts.ts:1`, `apps/billing/src/adapters/bus.adapter.ts:1`, `apps/billing/test/bus.adapter.test.ts:1`).
