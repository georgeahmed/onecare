Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | Prev: — | [Next](SEC-01.2.md)

Task: SEC-01.1 — Logging redaction utility

Context
- Ensure logs never contain PHI/PII or secrets.

Files
- packages/observability/src/logger.ts

Steps
1) Implement redact(obj) to strip tokens/ids/PII patterns (basic regex stubs ok).
2) Apply in logger.log to sanitize fields.
3) Unit: examples with emails/phones/tokens are redacted.

Acceptance Criteria
- Tests pass; no sensitive data in logs.

Validate
- npm run test

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-01.1' && make team-status-write
