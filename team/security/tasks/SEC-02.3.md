Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.2.md) | [Next](SEC-02.4.md)

Task: SEC-02.3 — DPIA template & privacy impact checks

Context
- Provide a Data Protection Impact Assessment (DPIA) template and a lightweight checklist to run privacy reviews on new features.

Files
- docs/security/DPIA_TEMPLATE.md (new)
- docs/security/PRIVACY_CHECKLIST.md (new)

Steps
1) Author a DPIA template covering purpose, data categories, flows, storage, retention, and risk mitigations.
2) Create a short privacy checklist for PRs and feature proposals; integrate as part of design reviews.
3) Pilot DPIA on telephony parity and feature store flows; record findings.

Acceptance Criteria
- DPIA and checklist published; at least one pilot completed; actions tracked.

Validate
- Team review; store signed-off DPIA doc in repo.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.3' && make team-status-write

