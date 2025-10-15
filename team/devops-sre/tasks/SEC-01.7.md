Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.6.md) | [Next](SRE-01.1.md)

Task: SEC-01.7 — Pen-test checklist and hardening backlog

Context
- Prepare a checklist for internal/external pentests and maintain a hardening backlog across containers, network, and applications.

Files
- docs/SECURITY_PENTEST.md (new)

Steps
1) Create a pentest checklist (scope, endpoints, credentials, test data policy, reporting) and link to environment prep steps.
2) Capture findings into a hardening backlog categorized by priority, with owners and target dates.

Current Findings
- `docs/SECURITY_PENTEST.md` has not been created; there is no visible pentest checklist or hardening backlog in the repo.

Acceptance Criteria
- Checklist published; backlog process established; initial items captured.

Validate
- Peer review; run a dry‑run security review.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SEC-01.7' && make team-status-write
