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

Status: complete
Progress: 100%

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
- none — backlog is clear; see completed log for references.
