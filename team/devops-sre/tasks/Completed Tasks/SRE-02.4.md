Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.3.md) | [Next](SRE-02.5.md)

Task: SRE-02.4 — Alerts templates for triage latency breach, scribe backlog

Context
- Provide reusable alert templates for critical user-facing concerns: triage latency SLO breaches and scribe backlog growth.

Files
- docs/observability/alerts/TRIAGE_LATENCY.yaml (new)
- docs/observability/alerts/SCRIBE_BACKLOG.yaml (new)
- docs/observability/alerts/README.md (new)

Steps
1) Create alert templates with variables for thresholds, durations, and labels; document assumptions and integration steps.
2) Add a short README explaining how to adopt these in common platforms (Prometheus/Grafana/Cloud provider equivalents).

Acceptance Criteria
- Alert templates exist and are documented; thresholds and labels are clearly parameterized.

Validate
- Manual: review templates; simulate fake metrics locally if applicable; confirm YAML lint passes.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.4' && make team-status-write

