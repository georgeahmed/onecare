Task: <ID> — <Short, Actionable Title>

Context
- Brief why and what; link to related README/ADR/schemas for background.

Files
- <workspace-relative path> (new|updated)
- <another path> (reference)

Steps
1) Concrete, verifiable actions in small increments.
2) Reference contracts-first where applicable: edit `schemas/*`, run `npm run codegen`.
3) Call out guardrails: timeouts, retries with backoff/jitter, idempotency.

Acceptance Criteria
- Specific, testable outcomes (typecheck/tests pass; endpoint returns shape; logs/metrics present).

Validate
- Exact commands (e.g., `npm run build && npm run typecheck`, `pytest -q services-py/tests`).

Status Update
- make engineer-done ENGINEER=<team/engineer-X> TASK='<ID>' && make team-status-write

Notes
- Keep PHI/PII out of logs and artifacts; propagate correlationId.
- Prefer compiled validators and contract tests when touching payloads/envelopes.
