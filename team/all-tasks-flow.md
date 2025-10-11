All Tasks Flow — Program Management

Purpose
- Provide a clear, scannable map of delivery gates, what runs in parallel, and where to find each task’s details.
- Help engineers and PMs align on sequencing, entry/exit criteria, and status hygiene.

How To Use
- Find your Task ID in `docs/TASK_INDEX.md` and your team’s folder under `team/<dept>/tasks/`.
- Work only on tasks for the current gate unless explicitly approved to parallelize.
- Update your engineer file and status when you finish: `make engineer-done ENGINEER=<team/engineer-X> TASK='<ID>' && make team-status-write`.
- For background on contracts-first and envelopes, see `docs/SCHEMAS.md` and `docs/EVENTS.md`.

Legend
- `A → B` = B starts after A completes (strict sequence)
- `[ A | B | C ]` = items can run in parallel after the previous gate completes
- Ranges `X-01.1 .. X-01.n` indicate a contiguous series of tasks

High‑Level Flow
- G0 → G1 → G2 → G3 → G4 → G5 → G6
- G2+ Observability/Security starts at G2 and runs in parallel; must land by G5.

Gate Overview (one‑liners)
- G0 Contracts & Codegen — Contracts are source of truth; codegen passes; QA seed harness ready.
- G1 Broker & Infra — Message bus reachable; secrets managed; guardrails in place (limits/backups).
- G2 Bus Adapter Minimal — Durable pub/sub working with DLQ; health/metrics exposed.
- G2+ Observability & Security — Baseline telemetry, correlation, alerts, and redaction.
- G3 Orchestrator Ingress — Zero‑trust ingress with verification, consent, and guardrails.
- G4 Domain Flows — Parallel functional tracks implement core workflows.
- G5 E2E & Performance — System E2E happy path + perf checks are green.
- G6 Release Readiness — Criteria met; runbooks/dashboards in place; system marked ready.

Gate Details

G0 — Contracts & Codegen
- QA-01.1, QA-01.2 — Schema validation harness + core contracts.

G1 — Broker & Secrets Bootstrap
- SRE-01.1 .. SRE-01.5 — NATS URL, secrets policy, CI cache, resource limits, backups.
- MO-01.* — Health, containers, traces/metrics, env docs, dashboards.

G2 — Bus Adapter Minimal
- BE-02.1 .. BE-02.4 — NATS adapter, factory injection, health/metrics, DLQ.

G2+ — Observability & Security Baseline [parallel]
- SRE-02.1 .. SRE-02.5 — Collector, correlation propagation, SLOs, alerts, Node OTEL.
- SEC-01.1, SEC-01.2 — Log redaction, AuthZ matrix.
- MO-01.7 — CI scanning.

G3 — Orchestrator Ingress (Zero‑Trust)
- BE-01.1 .. BE-01.8 — Verify/auth/consent, typed config, triage publish, audit, error envelope, idempotency, normalize/validate, guardrails.
- IN-01.6 .. IN-01.7 — YAML loader merge + floors/ceilings, FHIR validate stub.

G4 — Domain Flows [parallel]
- Triage — BE-03.1 .. BE-03.5
- Booking — IN-02.1 .. IN-02.6, BE-04.1 .. BE-04.3
- Pharmacy — IN-03.1 .. IN-03.6, BE-05.1 .. BE-05.3
- Access & Capacity — BE-06.1 .. BE-06.5
- ICS & Automation — IN-03.6, BE-07.1 .. BE-07.2
- Telephony/Voice — TV-01.1 .. TV-01.4, TV-02.1 .. TV-02.5
- ML Safety/Acuity/Scribe — ML-01.1 .. ML-01.8, ML-02.1 .. ML-02.6, ML-03.1 .. ML-03.6, ML-04.1 .. ML-04.6
- MLOps — MO-01.1 .. MO-01.7, MO-02.1 .. MO-02.6
- Data Engineering — DE-01.1 .. DE-01.6, DE-02.1 .. DE-02.5
- Frontend — FE-01.1 .. FE-01.7, FE-02.1 .. FE-02.5, FE-03.1 .. FE-03.5
- QA — QA-01.3 .. QA-01.6, QA-02.1 .. QA-02.6

G5 — E2E & Performance
- QA-01.3 .. QA-01.6; QA-02.1 .. QA-02.6 — End‑to‑end flows and perf/telephony checks.

G6 — Release Readiness
- Criteria: CI green, E2E stable, SLOs satisfied, runbooks & dashboards ready → SYSTEM_READY.

Parallelization Rules
- Gates complete in sequence; do not start G(n+1) until G(n) exits, except G2+ which runs alongside G2–G4.
- Tracks listed under G4 run concurrently after G3 completes.

References
- Task index and details — `docs/TASK_INDEX.md`
- System readiness criteria — `docs/SYSTEM_READINESS.md`
- Release checklist — `docs/RELEASE_READINESS.md`
- Team folders — `team/<dept>/tasks/`
- Engineer task template — `docs/TASK_TEMPLATE.md`

Notes
- Use the contracts‑first workflow: edit `schemas/*`, run `npm run codegen`, then implement.
- Keep PHI/PII out of logs; propagate `x-correlation-id`; enforce timeouts/retries/idempotency.
