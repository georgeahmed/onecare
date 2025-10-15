Engineer: Backend 02

Role: Backend Engineer (TypeScript, Event-Driven)
Stack: TypeScript, Node.js, NATS/Kafka, @onecare/bus

Responsibilities
-- Implement NATS (or Kafka) adapter for @onecare/bus; replace MemoryBus in orchestrator.
- Add DLQ handling and retry/backoff policies; ensure at-least-once semantics.

Initial Tasks
- Create real bus impl under packages/bus (nats.ts) with publish/subscribe.
- Add connection health checks; basic metrics.
- Update orchestrator to inject bus via adapter factory.

Start Here
- Algorithm.md: 0.3 Event Bus (topics) + 0.8 Architecture graph
- Topics: packages/events/src/topics.ts
- Bus types: packages/bus/src/types.ts

Contracts & Validation
- DLQ contract: `schemas/common/dlq-event.json` (DlqEvent). Enforce on DLQ publishes.
- Envelope: standardize headers/correlation via `@onecare/events` envelope utilities.
- ADR: docs/adr/2025-10-11-bus-injection.md

Status: in-progress
Progress: 26%

Dependencies
- devops-sre/engineer-01 (Broker infra)
- backend/engineer-01 (Orchestrator integration)
- qa-automation/engineer-01 (Contract tests)

Platform Checklist (pre-flight)
- Broker reachable with TLS and credentials (certs/keys via secrets); egress/firewall rules in place.
- Subjects/streams created for topics and DLQ; subject ACLs applied; retention/quotas configured.
- Contract validation harness (Ajv) and codegen integrated for envelope schema + topic allowlist.
- Observability sinks available (logs, metrics, traces) and correlationId convention agreed.
- Shared IdempotencyStore (Redis) available for consumers that dedupe on ingress.
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks
Completed tasks have moved to `team/backend/Completed Tasks/engineer-02.md`.

Incomplete
- [ ] BE-02.5a — Connection resilience (pending jittered backoff and status emitters in bus/orchestrator).
- [ ] BE-02.5b — Metrics for reconnects, drops, and lag (no reconnect/lag metrics or instrumentation yet).
- [ ] BE-02.6a — At-least-once semantics + dedupe keys (failures ack after DLQ; dedupe keys untouched).
- [ ] BE-02.6b — Idempotency on consume (key propagation) (no idempotency store integration or key propagation).
- [ ] BE-02.7 — Ordering/partitioning (keyed subjects; per-tenant ordering guarantees) (subjects remain unpartitioned).
- [ ] BE-02.8 — Flow control/backpressure (prefetch/credits, size limits; pressure signals) (no adaptive flow control or pressure signals).
- [ ] BE-02.9 — Security hardening (TLS, creds, subject ACLs; secret rotation readiness) (TLS creds/rotation not implemented).
- [ ] BE-02.10 — Observability (latency histograms, error/retry counters, spans; correlationId propagation) (no bus-level metrics or tracing spans).
- [ ] BE-02.11 — Health/readiness (ping bus, durable sub status; probe cache) (lack readiness probes beyond basic `busReady` flag).
- [ ] BE-02.13 — Advanced DLQ/retry (bounded retries, poison detection, requeue tooling) (no advanced retry/DLQ tooling).
- [ ] BE-02.14 — Parity tests vs MemoryBus (deterministic; no network in unit) (parity test suite not started).
- [ ] BE-02.15 — Docs & ADRs (bus selection, semantics, operational playbook) (operational docs/playbooks still missing).
- [ ] BE-02.16 — Multi-tenant isolation/quotas (partitioning, throughput caps) (no quotas or tenant isolation controls).
- [ ] BE-02.17 — Size/compression policies (max bytes, compression support) (no payload size/compression policy enforcement).
- [ ] BE-02.18 — Partitioning strategy doc + tests (ordering, hot-keys) (partitioning doc/tests absent).
- [ ] BE-02.19 — Performance baselines/soak (p50/p95, sustained throughput, backpressure) (no performance baselines recorded).
- [ ] BE-02.20 — Runbooks & alerting (storms, DLQ spikes, lag thresholds) (alerting/runbook coverage outstanding).
