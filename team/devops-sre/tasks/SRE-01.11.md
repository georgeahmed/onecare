Task: SRE-01.11 — SLOs & alerting (latency p95, error rates, DLQ growth, readiness flaps)

Context
- Define service‑level objectives and wire alerting for sustained breaches and instability.

Files
- docs/SLOs.md (new)
- infra/monitoring/alerts.yml (new)

Steps
1) Define SLOs per service (e.g., triage p95 < 2s, portal uptime 99.9%) and corresponding error budgets; document in SLOs.md.
2) Author alert rules for latency p95/99, error rate, DLQ size growth, readiness flap rate; include durations and thresholds.
3) Document the on‑call escalation path and runbook links.

Acceptance Criteria
- SLOs published; alert rules authored; on‑call docs exist.

Validate
- Dry‑run alerts (tooling or manual threshold triggers) in dev.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.11' && make team-status-write

