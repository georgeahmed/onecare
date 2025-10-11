Engineer: Backend 01

Role: Backend Engineer (TypeScript, Event-Driven)
Stack: TypeScript, Node.js, JSON Schema, @onecare/statekit, @onecare/bus, @onecare/ports

Responsibilities
- System Orchestrator end-to-end:
  - Verify signature + replay guard, authorize, check consent (zero-trust)
  - Normalize to FHIR, validate profiles, MPI, link resources
  - Transactional upsert (bundle), enrichment (coding/dedup hooks), routing publishes
  - Metrics + immutable audit (WORM) and correlation IDs
- Config enforcement (floors/ceilings) and failure modes (timeouts + rules fallback)

Initial Tasks
- Implement security stubs usage in orchestrator: apps/orchestrator/src
- Enforce config reading + floors/ceilings via @onecare/config
- Wire FHIR upsert port into orchestrator: packages/ports/src/fhir.ts
- Publish triage.input with EventEnvelope: packages/events
- Emit audit events and metrics; use correlation IDs

Start Here
- Algorithm.md: 1) System Orchestrator (sequence + pseudocode)
- Contracts: schemas/common/event-envelope.json, schemas/ingest/portal-submission.json
- Ports: packages/ports/src/fhir.ts, packages/ports/src/audit.ts
- Topics: packages/events/src/topics.ts
- Observability: packages/observability/src/logger.ts, src/otel.ts

Contracts & Validation
- Source of truth: `schemas/*`; run `npm run codegen` after schema edits.
- Use Ajv harness (see QA-01.1) to validate critical payloads in tests.
- Ensure error envelopes follow `docs/ERRORS.md` and DLQ follows `schemas/common/dlq-event.json`.
- Release: docs/RELEASE_READINESS.md

Status: active
Progress: 29%

Dependencies
- integrations/engineer-01 (FHIR repo, Object Store, Consent)
- backend/engineer-02 (Bus impl)
- devops-sre/engineer-01 (Infra/CI)
- qa-automation/engineer-01 (Contracts/E2E)

Platform Checklist (pre-flight)
- Bus durability (BE-02.4) in place or MemoryBus gated behind feature flag for dev.
- Shared IdempotencyStore (Redis) configured for ingress; reserve semantics verified.
- Contract validation harness and codegen available; schemas current.
- Observability base: logger auto correlationId, counters/timers, spans.

Tasks
- [x] BE-01.1 — Add zero-trust gate (verify/auth/consent) plumbing
- [x] BE-01.2 — Load typed config + enforce floors/ceilings
- [x] BE-01.3 — Publish triage.input envelope on SAFE
- [x] BE-01.4 — Emit audit event on success/deny
- [ ] BE-01.15 — Contract compliance & codegen (update schemas first; run TS/Py codegen; wire validators; CI gate: npm run typecheck && npm run test)
- [ ] BE-01.9 — Orchestrator state machine skeleton (@onecare/statekit) with explicit states, time budgets, failure transitions, and decision/result objects; unit-tested
- [ ] BE-01.5a — Error codes/types from schema + envelope helper
- [ ] BE-01.5b — Status mapping + HTTP handler wrapper
- [ ] BE-01.5c — Logging redaction + error metrics
- [ ] BE-01.5d — Tests + docs for error taxonomy
- [ ] BE-01.6a — IdempotencyStore interface (reserve/commit/release)
- [ ] BE-01.6b — Key/header derivation + TTL config
- [ ] BE-01.6c — 409 path + metrics/logs (race-safe)
- [ ] BE-01.6d — Concurrency tests (sequential + parallel)
- [ ] BE-01.7a — normalizeToFhir + fixtures (pure)
- [ ] BE-01.7b — HTTP edge schema validation
- [ ] BE-01.7c — Profile validation hook + error mapping
- [ ] BE-01.7d — Wire upsert + audit + unit tests
- [ ] BE-01.8a — callWithGuard (timeout/retry/backoff)
- [ ] BE-01.8b — Circuit breaker (half-open) semantics
- [ ] BE-01.8c — Correlation propagation + metrics/OTel
- [ ] BE-01.8d — Safety fallback ('rules') + budgets
- [ ] BE-01.10 — HTTP ingress hardening (JSON Schema validation with compiled validators, strict content-type, body size limits, structured 400 envelopes)
- [ ] BE-01.11 — Observability end-to-end (OpenTelemetry traces, latency/error-rate metrics, structured logs; correlationId propagation across HTTP→bus→ports)
- [ ] BE-01.12 — Security hardening (SSRF allowlist for outbound URLs, header/input sanitation, safe JSON parsing/redaction, deny-by-default on missing consent)
- [ ] BE-01.13 — Audit ledger resiliency (async writes with bounded spool-on-fail, timeouts, backoff; dedupe protection; WORM target alignment; metrics)
- [ ] BE-01.14 — Backpressure + time budgets (global and per-state concurrency limits, graceful degrade with 429/503 + rules fallback; abort on budget breach; metrics)
- [ ] BE-01.16 — DLQ and retry policy (define event DLQ topics, poison-message quarantine, bounded retries with backoff; idempotency keys on publish/consume)
- [ ] BE-01.17 — Rate limiting & abuse protection (token-bucket by tenant/account; safe defaults via @onecare/config; 429 error envelope + metrics)
- [ ] BE-01.18 — Health/readiness/liveness + graceful shutdown (drain in-flight, close bus/ports; k8s-friendly probes; timeouts)
- [ ] BE-01.19 — Fault injection tests (simulate timeouts, partial failures, slow responses; verify circuit breaker, retries, and backpressure behavior; no network in unit tests)
- [ ] BE-01.20 — Privacy/PII/PHI minimization (redact tokens/IDs in logs, avoid PHI in events; validation at edges; update data handling notes)
- [ ] BE-01.21 — Performance baselines (set SLOs, measure p50/p95 latencies and throughput locally with autocannon; microbench hot mapping paths; doc budgets)
- [ ] BE-01.22 — Documentation & ADRs (short ADRs for orchestrator design, resilience strategy, and error taxonomy; update service README with examples and USAGE)
