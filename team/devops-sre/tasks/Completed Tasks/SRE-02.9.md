Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.8.md) | Next: —

Task: SRE-02.9 — Alert hygiene (dedupe, silence windows, runbook links) and on-call guide

Context
- Reduce alert fatigue by deduplicating, adding silence windows, and linking runbooks; document on-call expectations.

Files
- docs/observability/ALERTING.md (new)

Steps
1) Configure alert dedupe/grouping and silence windows during planned maintenance; add runbook links to alert annotations.
2) Author on-call guide with escalation policy and response timelines.

Implementation Notes
- `docs/observability/ALERTING.md` documents dedupe knobs, silence workflows, and on-call expectations with links for latency/backlog runbooks.
- Alert templates reference the guide via the `runbook` annotation in `docs/observability/alerts/*.yaml`.

Acceptance Criteria
- Alert policy documented; examples in templates include runbook links.

Validate
- Review alert configs; run a tabletop exercise.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.9' && make team-status-write
