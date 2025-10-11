All Tasks Flow — Program Management

Legend
- A → B means B runs after A (strict sequence)
- [ A | B | C ] means items can run in parallel after the previous gate completes
- For full details per task, see docs/TASK_INDEX.md

Gate Overview
- G0 Contracts & Codegen (seed test harness)
- G1 Broker & Infra (message bus + secrets)
- G2 Bus Adapter Minimal (durable pub/sub + DLQ)
- G2+ Observability & Security Baseline (parallel)
- G3 Orchestrator Ingress (zero‑trust)
- G4 Domain Flows (parallel tracks)
- G5 E2E & Performance
- G6 Release Readiness

G0 Contracts & Codegen
- QA-01.1, QA-01.2 (schema validation harness + core contracts)

G1 Broker & Secrets Bootstrap
- SRE-01.1, SRE-01.2, SRE-01.3, SRE-01.4, SRE-01.5 (NATS URL, secrets policy, CI cache, resource limits, backups)
- MO-01.* (health, containers, traces/metrics, env docs, dashboards)

G2 Bus Adapter Minimal
- BE-02.1, BE-02.2, BE-02.3, BE-02.4 (NATS adapter, factory injection, health/metrics, DLQ)

G2+ Observability & Security Baseline [parallel]
- SRE-02.1, SRE-02.2, SRE-02.3, SRE-02.4, SRE-02.5 (collector, correlation, SLOs, alerts, Node OTEL)
- SEC-01.1, SEC-01.2 (log redaction, AuthZ matrix)
- MO-01.7 (CI scanning)

G3 Orchestrator Ingress (Zero‑Trust)
- BE-01.1 .. BE-01.8 (verify/auth/consent, typed config, triage publish, audit, error envelope, idempotency, normalize/validate, guardrails)
- IN-01.6 .. IN-01.7 (YAML loader merge + floors/ceilings, FHIR validate stub)

G4 Domain Flows [parallel]
- Triage: BE-03.1 .. BE-03.5
- Booking: IN-02.1 .. IN-02.6, BE-04.1 .. BE-04.3
- Pharmacy: IN-03.1 .. IN-03.6, BE-05.1 .. BE-05.3
- Access & Capacity: BE-06.1 .. BE-06.5
- ICS & Automation: IN-03.6, BE-07.1 .. BE-07.2
- Telephony/Voice: TV-01.1 .. TV-01.4, TV-02.1 .. TV-02.5
- ML Safety/Acuity/Scribe: ML-01.1 .. ML-01.8, ML-02.1 .. ML-02.6, ML-03.1 .. ML-03.6, ML-04.1 .. ML-04.6
- MLOps: MO-01.1 .. MO-01.7, MO-02.1 .. MO-02.6
- Data Engineering: DE-01.1 .. DE-01.6, DE-02.1 .. DE-02.5
- Frontend: FE-01.1 .. FE-01.7, FE-02.1 .. FE-02.5, FE-03.1 .. FE-03.5
- QA: QA-01.3 .. QA-01.6, QA-02.1 .. QA-02.6

G5 E2E & Performance
- QA-01.3, QA-01.4, QA-01.5, QA-01.6; QA-02.1 .. QA-02.6 (end‑to‑end and perf/telephony flows)

G6 Release Readiness
- Criteria: CI green, E2E stable, SLOs satisfied, runbooks & dashboards ready → SYSTEM_READY

Notes
- Gates complete in order; tracks in G4 run concurrently. Use the engineer-loop per Task ID.
- For exact task steps and commands, open docs/TASK_INDEX.md or team/<dept>/tasks/*.md
