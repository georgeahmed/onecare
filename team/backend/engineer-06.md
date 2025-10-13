Engineer: Backend 06

Role: Backend Engineer (Access Gate)
Stack: TypeScript, Scheduler, @onecare/config

Responsibilities
- Portal Uptime Guard; OOH policy; Safety Gate call orchestration from web.
- Capacity Shaper & Access Co-Pilot: forecasting, micro-releases, guardrailed proposals

Initial Tasks
- Implement scheduler jobs for GuardPortal using apps/access-gate/src/scheduler.ts
- Hook config OOH policy and core hours.
- Implement ShapeCapacity() loop with telemetry stubs and micro-release actions.

Start Here
- Algorithm.md: 2) Access Front Door, 6) Capacity Shaper & Access Co-Pilot
- Config: config/nhs_gp_defaults.yaml (core_hours, ooh_policy, hold_back_fraction)

Contracts & Validation
- For portal.notify events, define/update schemas first; run codegen.
- Validate notify payloads in tests; no PHI in messages or logs.

Status: planned
Progress: 0%

Dependencies
- data-engineering/engineer-01 (Telemetry/metrics)
- devops-sre/engineer-01 (Scheduler/infra)
- ml/engineer-01 (Safety thresholds)

Platform Checklist (pre-flight)
- Scheduler runtime configured (TZ set; DST-aware); clock sync (NTP) verified; monotonic timers available.
- Core hours and OOH policy loaded from config; defaults validated.
- Bus durability (BE-02.4) and DLQ topics, if publishing portal events.
- Shared IdempotencyStore (Redis) for scheduler idempotency.
- Observability base (logger auto correlationId; counters/timers; spans).
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks
- [ ] BE-06.1 — Portal Uptime Guard schedule (TZ/DST-safe scheduler with jitter; idempotent state ensure; metrics)
- [ ] BE-06.2 — OOH deferral queue (persisted queue with TTL, flush-on-core-hours, metrics)
- [ ] BE-06.3 — ShapeCapacity micro-release (forecast delta → bounded release; guardrails + audit)
- [ ] BE-06.4 — Portal notify event (contract-first; envelope + DLQ; idempotency)
- [ ] BE-06.5 — Capacity telemetry adapter (abstraction, stubs, and health; no network in tests)
- [ ] BE-06.6 — Scheduler resilience & idempotency (singleton per practice, jitter, clock skew tolerance)
- [ ] BE-06.7 — Observability for access/capacity (structured logs, metrics, spans; correlationId)
- [ ] BE-06.8 — Front-door rate limiting (tenant/account token-bucket; 429 envelope; metrics)
- [ ] BE-06.9 — Portal event DLQ & retries (bounded retries with jitter; poison quarantine; minimal context)
- [ ] BE-06.10 — Health/readiness/liveness + graceful shutdown for schedulers
- [ ] BE-06.11 — Fault injection tests (tick delays, partial failures, clock drift)
- [ ] BE-06.12 — Privacy/PII minimization (notify payloads contain no PHI; redaction in logs)
- [ ] BE-06.13 — Performance baselines (tick latency, flush throughput; budgets documented)
