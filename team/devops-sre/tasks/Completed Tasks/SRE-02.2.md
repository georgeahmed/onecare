Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.1.md) | [Next](SRE-02.3.md)

Task: SRE-02.2 — Correlation IDs in logs + log format policy

Context
- Enforce consistent, structured JSON logs that include `correlationId` and redact sensitive fields. Provide a concise policy and examples.

Files
- packages/observability/src/logger.ts (confirm behavior; minor tweaks if needed)
- docs/observability/LOGGING_POLICY.md (new)

Steps
1) Document log format (ts, level, msg, correlationId, fields), redaction rules, and safe examples in `LOGGING_POLICY.md`.
2) Ensure the logger guarantees `correlationId` presence when available and redacts objects by default.
3) Add a short usage snippet to backend READMEs referencing the policy.

Acceptance Criteria
- Policy doc exists; logger behavior matches policy (correlationId, redaction, JSON output).

Validate
- Manual: run services locally; confirm emitted logs conform and contain correlationId.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.2' && make team-status-write

