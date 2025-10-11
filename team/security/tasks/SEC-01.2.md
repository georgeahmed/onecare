Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.1.md) | [Next](SEC-02.1.md)

Task: SEC-01.2 — AuthZ matrix documentation (scopes/actions)

Context
- Map actors → actions → resources for authorization clarity.

Files
- docs/SECURITY_AUTHZ.md

Steps
1) Document matrix of subject types (patient/practitioner/system) vs actions (submit, read, write, route).
2) Include consent requirements and audit expectations.

Acceptance Criteria
- Doc exists; referenced by AGENTS.md.

Validate
- Open docs/SECURITY_AUTHZ.md

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-01.2' && make team-status-write
