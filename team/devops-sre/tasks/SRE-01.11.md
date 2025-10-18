Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.10.md) | [Next](SRE-01.12.md)

Task: SRE-01.11 — SLOs & alerting (latency p95, error rates, DLQ growth, readiness flaps)

Context
- Define service‑level objectives and wire alerting for sustained breaches and instability.
- Current state: `docs/observability/SLOs.md` covers triage + scribe latency but omits DLQ/error-rate targets; alert templates live in `docs/observability/alerts/*.yaml` yet nothing under `infra/monitoring/` applies them, and there is no top-level `docs/SLOs.md`.

Files
- docs/observability/SLOs.md (expand) & docs/SLOs.md (summary/new)
- docs/observability/ALERTING.md
- docs/observability/alerts/*.yaml
- infra/monitoring/alerts/ (new PrometheusRule set)
- docs/runbooks/oncall.md (new or update)

Steps
1) Expand SLO coverage (latency, uptime, error rate, DLQ growth, readiness flaps) for orchestrator, booking, analytics, safety gate, telephony, etc.; publish a concise `docs/SLOs.md` that links back to the detailed `docs/observability/SLOs.md`.
2) Convert the alert templates into concrete PrometheusRule files under `infra/monitoring/alerts/` (or Helm values), wired for dev/staging, with severity tiers, runbook URLs, and burn-rate windows aligned to the SLOs.
3) Update `docs/observability/ALERTING.md` (or new on-call runbook) with the current escalation rotation, paging tooling, and links to each SLO/alert dashboard; cross-link from the SLO summary.

Acceptance Criteria
- Comprehensive SLO set published and linked; Prometheus alert rules are versioned in repo; on-call guide reflects active rotation + dashboards.

Validate
- `promtool check rules infra/monitoring/alerts/*.yaml`; simulate firing via `promtool test rules` or temporary metric injection; verify on-call doc referenced from SLO summary.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.11' && make team-status-write
