Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.6.md) | [Next](SEC-03.8.md)

Task: SEC-03.7 — AuthZ matrix → automated tests

Context
- Convert the documented authorization matrix into executable tests to prevent regressions.

Files
- qa/security/authz_matrix.spec.ts (new)
- docs/SECURITY_AUTHZ.md (reference)

Steps
1) Parse or encode the matrix of (actor, action, resource) and expected allow/deny outcomes.
2) Exercise endpoints or state machine decisions in a hermetic environment and assert outcomes.

Acceptance Criteria
- Automated tests reflect the matrix; changes to policy require test updates.

Validate
- npm run test:security; inspect failures and update policy/tests accordingly.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.7' && make team-status-write

