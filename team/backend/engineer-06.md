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

Status: in progress
Progress: 70%

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
Completed
- [x] [BE-06.1 — Portal Uptime Guard schedule](Completed%20Tasks/BE-06.1.md) — implemented in `apps/access-gate/src/scheduler.ts` with deterministic coverage in `apps/access-gate/test/portal.guard.test.ts`.
- [x] [BE-06.2 — OOH deferral queue](Completed%20Tasks/BE-06.2.md) — queue contracts in `packages/ports/src/deferrals.ts` with enqueue/flush exercised in `apps/access-gate/test/portal.guard.test.ts`.
- [x] [BE-06.3 — ShapeCapacity micro-release](Completed%20Tasks/BE-06.3.md) — state machine and audits shipped in `apps/capacity/src/application/capacity.state.ts` with extensive tests under `apps/capacity/test/`.
- [x] [BE-06.4 — Portal notify event](Completed%20Tasks/BE-06.4.md) — schema in `schemas/portal/notify.json`, publisher reliability in `apps/access-gate/src/adapters/portal-notifier.ts`, validated by `portal.notify.publisher.test.ts`.
- [x] [BE-06.5 — Capacity telemetry adapter](Completed%20Tasks/BE-06.5.md) — pluggable sources and caching in `apps/capacity/src/application/telemetry.ts` with coverage in telemetry tests.
- [x] [BE-06.6 — Scheduler resilience & idempotency](Completed%20Tasks/BE-06.6.md) — jittered singleflight scheduler with idempotent publish/flush behaviour, verified via `apps/access-gate/test/portal.guard.test.ts`.
- [x] [BE-06.11 — Fault injection tests](Completed%20Tasks/BE-06.11.md) — deterministic tests for DST drift, concurrent ticks, and adapter failures in `portal.guard.test.ts`.
- [x] [BE-06.12 — Privacy/PII minimization](Completed%20Tasks/BE-06.12.md) — logger redaction in `packages/observability/src/logger.ts` and safe payloads for portal events and logs.

Incomplete
- Priority (next up): BE-06.7 → BE-06.9 → BE-06.10 → BE-06.8 → BE-06.13.
- [ ] [BE-06.7 — Observability for access/capacity](tasks/BE-06.7.md) — spans/histograms still absent; only basic logs+counters exist.
- [ ] [BE-06.8 — Front-door rate limiting](tasks/BE-06.8.md) — ingress limiter and 429 envelope not yet implemented.
- [ ] [BE-06.9 — Portal event DLQ & retries](tasks/BE-06.9.md) — retry loop exists but lacks metrics and DLQ metadata coverage.
- [ ] [BE-06.10 — Health/readiness/liveness + graceful shutdown](tasks/BE-06.10.md) — probe endpoints and signal handling missing.
- [ ] [BE-06.13 — Performance baselines](tasks/BE-06.13.md) — microbench tests and perf documentation outstanding.
