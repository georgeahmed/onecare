Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.2.md) | [Next](SRE-02.4.md)

Task: SRE-02.3 — Define SLOs (triage p95, scribe p95, uptime) docs + CI guard

Context
- Establish initial service-level objectives (SLOs) and a lightweight CI guard that ensures SLO definitions are present and tracked.

Files
- docs/observability/SLOs.md (new)
- scripts/ci/slo_guard.sh (new)

Steps
1) Author `SLOs.md` defining targets and objectives for triage p95 latency, scribe p95 latency, and service uptime/error budgets.
2) Add `slo_guard.sh` to verify `SLOs.md` exists and contains required sections (triage, scribe, uptime) and is non-empty.
3) Wire the guard into CI (non-blocking initially) to enforce presence.

Acceptance Criteria
- SLOs are documented with clear targets; CI guard checks for presence/sections.

Validate
- Run the guard locally; ensure it passes; confirm CI executes the step.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.3' && make team-status-write

