Release Readiness — Orchestrator (BE-01)

Scope
- This checklist ties Backend Engineer 1 deliverables to system-level gates for a stable, production-ready System Orchestrator.
- Mark each item complete and link to PRs/tests. Coordinate cross-team items with BE‑02, Integrations, SRE, and QA.

Contracts & Validation
- [ ] Schemas up to date (envelopes, ingest, safety, audit, DLQ, config). Codegen run and committed.
  - Commands: `npm run codegen`, `npm run codegen:check`
- [ ] Generated types used at edges; HTTP body validated against `schemas/ingest/portal-submission.json`.
- [ ] Error taxonomy aligned to `schemas/common/error-envelope.json`; responses validate.
- [ ] EventEnvelope type usage reconciled (generic vs non-generic) with a consistent approach across apps.

Security & Privacy
- [ ] Zero‑trust gate in place (verify signature, replay guard, authorize, consent) with deny‑by‑default. (BE‑01.1, BE‑01.1H)
- [ ] PII/PHI redaction for logs, metrics, and audit; secrets never logged. (BE‑01.14, BE‑01.20)
- [ ] SSRF allowlist enforced for outbound hosts. (BE‑01.12)
- [ ] Rate limiting (pre/post auth) returns 429 envelopes; safe defaults via config. (BE‑01.12, BE‑01.17)
- [ ] Input sanitation: strict content-type, size limits, header normalization. (BE‑01.10)

Resilience & Idempotency
- [ ] Idempotency guard with atomic reserve/commit/release, TTL configured; 409 on duplicates. (BE‑01.6a..6d)
- [ ] Outbound guardrails: timeouts, retries with jitter, circuit breaker with half‑open, error classification. (BE‑01.8a..8c)
- [ ] Fallback behavior for safety gate per config (‘rules’) with budgets. (BE‑01.8d)
- [ ] Reliable publish with ack/timeout/retry; DLQ event on max attempts. (BE‑01.3H, BE‑01.16)
- [ ] Audit writes non‑blocking, redacted, and resilient (bounded queue). (BE‑01.4H, BE‑01.13)

Observability & SLOs
- [ ] OTel traces across HTTP → states → outbound ports; correlationId propagated end‑to‑end. (BE‑01.11)
- [ ] Metrics: request durations, error codes, retry/timeout/CB open counts, idempotency hit/miss, audit queue depth. (BE‑01.10, BE‑01.11, BE‑01.6, BE‑01.13)
- [ ] SLOs defined (availability, p50/p95 latency) with baselines documented; initial alerts configured. (BE‑01.21)

Performance & Backpressure
- [ ] Backpressure controls: global/per‑state concurrency caps; 429/503 on saturation with retry‑after. (BE‑01.14)
- [ ] Load test shows stable p50/p95 under target concurrency; mapping hot paths micro‑benchmarked. (BE‑01.21)

Operations
- [ ] Health/liveness and readiness endpoints; readiness reflects dependencies and backpressure. (BE‑01.18)
- [ ] Graceful shutdown drains in‑flight work and closes adapters within budget. (BE‑01.18)
- [ ] Config validated against schema at startup; effective config logged once (redacted). (BE‑01.2H)
- [ ] Rollout plan: image build, env/secrets, probes, resources/limits, and rollback steps documented.

Dependencies (cross‑team gates)
- [ ] Event Bus durability, consumer groups, and DLQ routing ready. (BE‑02)
- [ ] FHIR Repository and Object Store ports available with SLAs. (Integrations)
- [ ] Distributed Idempotency Store or acceptable interim design documented. (BE‑02/SRE)
- [ ] CI/CD, observability backend, TLS/secrets, backups/DR configured. (SRE)
- [ ] E2E and contract tests across services green. (QA)

Testing & QA
- [ ] Unit tests: error mapping, ingress validation, idempotency concurrency, call guard retries/CB, normalize fixtures. (BE‑01.5d, 6d, 7a, 7b, 8a)
- [ ] Fault injection tests: timeouts, partial failures, saturation/backpressure. (BE‑01.19)
- [ ] Contract tests for critical envelopes/payloads succeed; no network in unit tests. (BE‑01.15)

Documentation
- [ ] ADRs for orchestrator design, error taxonomy, idempotency, guardrails. (BE‑01.22)
- [ ] Orchestrator README updated with endpoints, env vars, examples, error envelopes. (BE‑01.22)
- [ ] USAGE updated for commands, scripts, run modes. (BE‑01.22)

Go/No‑Go Criteria
- [ ] Typecheck/lint/tests green across monorepo; coverage threshold met for orchestrator.
- [ ] Container image builds; SBOM/vulnerability scan acceptable.
- [ ] Dashboards show healthy latencies and error budgets under smoke load.
- [ ] Rollback plan validated (can revert to previous version cleanly).

