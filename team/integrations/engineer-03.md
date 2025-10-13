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

Status: planned
Progress: 0%

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
- [ ] IN-03.1 — CPCS client interface skeleton (typed, env/config wiring)
- [ ] IN-03.2 — CPCS referral flow (timeouts/retries/jitter/CB; slotless fallback; error mapping)
- [ ] IN-03.3 — ICS referral/ack client (TLS/auth; route mapping; ack semantics)
- [ ] IN-03.4 — Billing interface placeholder (Claim/Response; TLS/auth; timeouts)
- [ ] IN-03.5 — Observability for CPCS/ICS (structured logs, latency histograms, error counters, spans)
- [ ] IN-03.6 — ICS org→endpoint map and routing policy (allowlist; per-org limits)
- [ ] IN-03.7 — Security & SSRF guardrails (CPCS/ICS): allowlists, no private IPs, header sanitation
- [ ] IN-03.8 — Contract-first ICS mapping (schemas/codegen; compiled validators; contract tests)
- [ ] IN-03.9 — Idempotency & dedupe (external call keys; suppress duplicate referrals/acks)
- [ ] IN-03.10 — DLQ and retry policy for ICS events (bounded retries; poison quarantine; minimal context)
- [ ] IN-03.11 — Health/readiness and graceful shutdown (client health; drain inflight)
- [ ] IN-03.12 — Fault injection tests (timeouts, partial failures, CB open, retries → DLQ)
- [ ] IN-03.13 — Performance baselines (p50/p95 call latency; budgets; soak)
- [ ] IN-03.14 — Privacy/PII minimization (no PHI in logs/events; redaction by default)
- [ ] IN-03.15 — Credential management & rotation readiness (env/secret stores; no sensitive logs)
- [ ] IN-03.16 — Documentation & ADRs (CPCS/ICS integration design, error mapping, ops)
 - [ ] IN-03.17 — API version/content negotiation (CPCS/ICS headers; Accept/Content-Type)
 - [ ] IN-03.18 — Credential/cert rotation readiness (OAuth/mTLS refresh; hot-reload)
 - [ ] IN-03.19 — Sandbox playback harness (ICS/CPCS deterministic fixtures; offline CI)
 - [ ] IN-03.20 — Adapter-level rate limits/backpressure (per-org caps; 429/503 mapping)
 - [ ] IN-03.21 — Billing contracts & validators (Claim/Response schemas; codegen; DLQ)
