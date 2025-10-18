Engineer: Backend 07

Role: Backend Engineer (ICS Hub)
Stack: TypeScript, @onecare/bus, @onecare/ports

Responsibilities
- ICS Hub: Cross-org exchange, routing policy, acks/retries, audit.
- Workflow Automation: docs, repeats, recalls task flows

Initial Tasks
- Implement ICS routing + audits; publish referral.request and handle referral.ack.
- Implement Workflow Automation service: listen to triggers, create/update Tasks, close loops.

Start Here
- Algorithm.md: 9) ICS Hub, 8) Workflow Automation
- Schemas: schemas/ics/*.json, schemas/tasks/task-created.json

Contracts & Validation
- Contract-first for `ics.referral.request/ack` and tasks events; run codegen.
- Validate ICS/task payloads with Ajv; DLQ events validate against `schemas/common/dlq-event.json`.

Status: in-progress
Progress: 75%

Dependencies
- integrations/engineer-03 (ICS integration)
- integrations/engineer-01 (FHIR repo)
- devops-sre/engineer-01 (Infra)

Platform Checklist (pre-flight)
- Bus durability (BE-02.4) and DLQ topics configured; consumer creds ready.
- Shared IdempotencyStore (Redis) for ack/automation dedupe.
- Contract validation harness (Ajv) and codegen integrated.
- Observability base (logger auto correlationId; metrics/spans) available.
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks

Completed
- [x] BE-07.1 — ICS ingress validation + routing policy skeleton (implemented in `apps/ics-hub/src/application`, covered by unit tests; see Completed Tasks/BE-07.1.md)
- [x] BE-07.2 — Workflow Automation triggers (policy-driven) (rules engine + tests landed; see Completed Tasks/BE-07.2.md)
- [x] BE-07.13 — Contract validators & codegen (schemas; TS/Py; compiled validators; codegen artifacts up to date; see Completed Tasks/BE-07.13.md)
- [x] BE-07.3 — ICS ack semantics and idempotency (acks emitted once with idempotent publishes, metrics, and tracing; see apps/ics-hub/src/application/ics.state.ts:422)
- [x] BE-07.4 — Outbound reliability (publish guardrails + DLQ) (bus adapter adds circuit breaker, retries, DLQ enrichment, plus ack helper; see apps/ics-hub/src/adapters/bus.adapter.ts:1)
- [x] BE-07.5 — Observability: routing metrics, ack latency, error rates (ack counters/histograms + spans wired; see apps/ics-hub/src/application/ics.state.ts:458)
- [x] BE-07.8 — Workflow Automation rule engine (config + debouncing) (rules accept debounce windows and normalisation; see apps/ics-hub/src/application/automation.rules.ts:200)
- [x] BE-07.9 — Automation idempotency and dedupe (stable publish keys + debounce TTL applied to context; see apps/ics-hub/src/application/ics.state.ts:594)
- [x] BE-07.10 — Contract tests for ICS and tasks events (Ajv contract suite guards schemas; see apps/ics-hub/test/contracts.test.ts:1)
- [x] BE-07.14 — Rate limiting & abuse protection (Retry-After headers surfaced on 429 decisions; see apps/ics-hub/src/application/ics.state.ts:327)
- [x] BE-07.17 — Health/readiness + graceful shutdown (probe server with cached readiness and shutdown hooks; see apps/ics-hub/src/index.ts:1)
- [x] BE-07.18 — Fault injection tests (resilience spec covers upstream failure + idempotent recovery; see apps/ics-hub/test/ics.resilience.test.ts:1)
- [x] BE-07.6 — Security & privacy: PHI minimization and redaction (DLQ payloads now emit redacted field summaries + digests; audit spool avoids raw payload logging; see apps/ics-hub/src/adapters/bus.adapter.ts:1 and apps/ics-hub/src/application/audit.spool.ts:1)
- [x] BE-07.7 — DLQ handling and reprocessing flow (operator replay gains idempotency guard + logging; DLQ replay integrates with publish guard; see apps/ics-hub/src/dev/replay.ts:1)
- [x] BE-07.11 — Backpressure and concurrency control (ProcessingLimiter enforces inflight caps with metrics; states respect limiter and emit Retry-After; see apps/ics-hub/src/application/backpressure.ts:1 and apps/ics-hub/src/application/ics.state.ts:188)
- [x] BE-07.12 — Audit ledger resiliency (bounded audit spool with retry + overflow metrics; state machine enqueues via spool; see apps/ics-hub/src/application/audit.spool.ts:1)
- [x] BE-07.15 — Performance baselines (routing/ack latency histograms + SLO doc at `docs/ics-hub-SLO.md`; validated via `apps/ics-hub/test/ics.perf.test.ts`)

Incomplete
- [ ] (none)
