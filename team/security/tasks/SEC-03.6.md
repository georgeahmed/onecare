Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.5.md) | [Next](SEC-03.7.md)

Task: SEC-03.6 — SSRF test suite (egress mocks; private IP redirection tests)

Context
- Validate SSRF guardrails by attempting redirects and IP literal access to private/link‑local ranges using controlled mocks.

Files
- qa/security/ssrf.spec.ts (new)

Steps
1) Stand up a local mock that attempts to redirect to 127.0.0.1/169.254.169.254 or RFC1918 ranges.
2) Assert outbound clients block these attempts and return `upstream_blocked` error codes.
3) Include allowlisted public host case to ensure normal flows still work.

Acceptance Criteria
- SSRF blocks verified; safe host allowed; tests deterministic.

Validate
- npm run test:security.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.6' && make team-status-write

