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

Status: in-progress
Progress: 78%

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
Completed tasks have moved to `team/backend/Completed Tasks/engineer-01.md`.

Incomplete
- [ ] BE-01.14 — No backpressure controls yet; HTTP handling lacks concurrency caps or overload responses (apps/orchestrator/src/index.ts:590).
- [ ] BE-01.16 — Triage publishes run without retry/DLQ routing and only target the primary topic (apps/orchestrator/src/application/orchestrator.state.ts:292).
- [ ] BE-01.17 — Rate limiting/abuse protection absent; `handleHttp` exposes no throttle or token-bucket logic (apps/orchestrator/src/index.ts:590).
- [ ] BE-01.18 — Health endpoints exist but there is no graceful shutdown or dependency drain on process signals (apps/orchestrator/src/index.ts:924).
- [ ] BE-01.19 — Fault-injection coverage is limited; there are no integration tests for downstream timeouts/backpressure behaviour (apps/orchestrator/test).
- [ ] BE-01.20 — Privacy guardrails still need work; triage payloads carry patient IDs/narratives and the release checklist lists PHI redaction as pending (apps/orchestrator/src/application/orchestrator.state.ts:287, docs/RELEASE_READINESS.md:16).
- [ ] BE-01.21 — Performance baselines/SLO documentation have not been produced; release readiness SLO items remain unchecked (docs/RELEASE_READINESS.md:31).
- [ ] BE-01.22 — Documentation/ADR updates incomplete; only an initial proposed ADR exists with no resilience/error taxonomy updates (docs/adr/2025-10-11-orchestrator.md:1, docs/RELEASE_READINESS.md:25).
