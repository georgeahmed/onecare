Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.13.md) | [Next](SEC-02.15.md)

Task: SEC-02.14 — Secure coding guidelines & checklists (Node/Python)

Context
- Provide practical secure coding checklists and examples for Node (TS) and Python services.

Files
- docs/security/SECURE_CODING_NODE.md (new)
- docs/security/SECURE_CODING_PY.md (new)

Steps
1) Node/TS: input validation, output encoding, SSRF rules, header sanitation, error handling, dependency hygiene.
2) Python: FastAPI security, Pydantic validation, avoid eval/exec, safe file handling, request timeouts.
3) Add PR checklist items and references to linters/formatters that support security rules.

Acceptance Criteria
- Guides published; PR checklist updated in CONTRIBUTING or AGENTS; developers adopt.

Validate
- Share guides; incorporate feedback.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.14' && make team-status-write

