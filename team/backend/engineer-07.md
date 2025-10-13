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

Status: planned
Progress: 0%

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
- [ ] BE-07.13 — Contract validators & codegen (schemas; TS/Py; compiled validators; contract tests)
- [ ] BE-07.1 — ICS ingress validation + routing policy skeleton
- [ ] BE-07.3 — ICS ack semantics and idempotency
- [ ] BE-07.4 — Outbound reliability (publish guardrails + DLQ)
- [ ] BE-07.7 — DLQ handling and reprocessing flow
- [ ] BE-07.14 — Rate limiting & abuse protection (per-org; 429 envelopes; metrics)
- [ ] BE-07.5 — Observability: routing metrics, ack latency, error rates
- [ ] BE-07.6 — Security & privacy: PHI minimization and redaction
- [ ] BE-07.11 — Backpressure and concurrency control (ICS Hub)
- [ ] BE-07.2 — Workflow Automation triggers (policy-driven)
- [ ] BE-07.8 — Workflow Automation rule engine (config + debouncing)
- [ ] BE-07.9 — Automation idempotency and dedupe
- [ ] BE-07.10 — Contract tests for ICS and tasks events
- [ ] BE-07.15 — Performance baselines (routing p50/p95; ack latency SLOs; budgets)
- [ ] BE-07.17 — Health/readiness + graceful shutdown (bus/repo checks; cached probes)
- [ ] BE-07.12 — Audit ledger resiliency (ICS + Automation)
- [ ] BE-07.18 — Fault injection tests (transient failures, DLQ paths, duplicate acks)
