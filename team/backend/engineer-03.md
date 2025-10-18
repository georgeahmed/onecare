Engineer: Backend 03

Role: Backend Engineer (TypeScript, Triage)
Stack: TypeScript, @onecare/statekit, @onecare/ports

Responsibilities
- Triage service flow: Intake → Scored → TaskCreated → Notified.
- Scoring function: f(acuity, risk, complexity, time, capacity) with config weights
- SLA aging + de-dup (similarity threshold), provider assignment (availability, workload, continuity, fairness)

Initial Tasks
- Define scoring interfaces and integrate with ML outputs (acuity, sim).
- Implement Task creation via FHIR port; emit tasks.created; notify queue.
- Implement de-dup window and similarity threshold from config.
- Implement provider assignment policy weights.

Start Here
- Algorithm.md: 3) AI Triage, SLA Aging, De-dup; provider_assignment weights
- Schemas: schemas/triage/triage-input.json, schemas/tasks/task-created.json
- Config: config/nhs_gp_defaults.yaml (triage.score_weights, sim_threshold)

Contracts & Validation
- Keep schemas current; run `npm run codegen` to refresh TS/Py models.
- Validate triage.input, tasks.created/updated payloads with Ajv (QA-01.1 harness pattern).

Status: in-progress
Progress: 30%

Dependencies
- ml/engineer-02 (Acuity model)
- integrations/engineer-01 (FHIR repo)
- backend/engineer-02 (Bus)
- qa-automation/engineer-01 (E2E flows)

Platform Checklist (pre-flight)
- Bus durability live (BE-02.4) with DLQ topics; consumer credentials configured.
- Shared IdempotencyStore (Redis) reachable; reserve semantics available.
- Contract validation harness ready (Ajv) and codegen wired into build.
- Observability base (logger auto correlationId; counters/timers; spans) available.
  - See also: docs/CONVENTIONS.md (Service Platform Checklist), infra/runbooks/tls-credentials.md, infra/event-bus/subjects-acls.md, infra/runbooks/idempotency-store.md, infra/event-bus/dlq-runbook.md

Tasks
- [x] BE-03.1b — Deterministic scoring with config weights; calibration + priority thresholds
- [x] BE-03.1c — Score bounding, tie-breakers, and stability across inputs
- [x] BE-03.3a — FHIR Task create idempotently (stable IDs; retries/backoff; guardrails)
- [x] BE-03.3b — Emit tasks.created; contract tests and validators
- [ ] BE-03.4a — Provider assignment policy (weights, fairness floors, continuity; pure; tests)
- [ ] BE-03.4b — Tie-breakers and backpressure-aware assignment
- [ ] BE-03.7 — Event-driven ingress (consume triage.input via bus; idempotency keys; bounded retries + DLQ)
- [ ] BE-03.8 — SLA aging and escalation (timer/interval, update Task priority/state; emit tasks.updated; tests)
- [ ] BE-03.9 — Fallbacks for missing ML (rules-based scoring thresholds; config-driven; consistent outcomes)
- [ ] BE-03.10 — Observability (correlationId propagation; metrics for scoring, dedup, assignment; spans)
- [ ] BE-03.11 — Security & privacy (PHI minimization in events/logs, consent checks when accessing patient context)
- [ ] BE-03.12 — Performance baselines (p50/p95 latency for scoring/assignment; microbench; doc budgets)
- [ ] BE-03.13 — DLQ and poison-message quarantine (bounded retries, safe payloads, remediation notes)
- [ ] BE-03.14 — Health/readiness for triage service (bus connectivity, repo reachability; graceful shutdown)
- [ ] BE-03.15 — Documentation & ADRs (scoring/assignment design, dedup strategy, event semantics)
