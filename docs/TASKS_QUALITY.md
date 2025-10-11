Task Cards Quality Guide

Purpose
- Ensure every task card is actionable, unambiguous, and production‑oriented so engineers can execute without guesswork.

Required Sections
- Task: Concise ID and title (e.g., ML-01.6 — FastAPI /analyze endpoint).
- Context: Why the task exists and constraints (SLOs, safety, privacy).
- Files: Concrete file paths to touch (mark new/updated/reference).
- Steps: Clear, ordered steps with specifics (timeouts, headers, budgets, commands).
- Acceptance Criteria: Verifiable outcomes tied to behavior, not implementation detail.
- Validate: Exact commands or checks to confirm correctness (deterministic; no network in unit tests).
- Status Update: `make engineer-done ENGINEER=... TASK='...' && make team-status-write`.

Best Practices
- Contracts first: If touching payloads/APIs, update `schemas/*` and run `npm run codegen` (+ Python as needed).
- Safety: No PHI/PII or secrets in logs; propagate `x-correlation-id`; honor timeouts/retries/backoff; idempotency where applicable.
- Observability: Define metrics/spans/logs and what to watch (p50/p95, error rates, DLQ growth).
- Determinism: Unit tests are hermetic; use fakes/mocks; forbid network.
- Dependencies: Call out upstream/downstream dependencies when ordering matters.
- Scope: Keep tasks small and self‑contained; avoid drive‑by refactors.

Template
Task: <ID — Title>

Context
- <1–3 bullets>

Files
- <path> (new|updated|reference)
- <path> (new|updated|reference)

Steps
1) <step>
2) <step>

Acceptance Criteria
- <result>

Validate
- <command>

Status Update
- make engineer-done ENGINEER=<team/engineer-X> TASK='<ID>' && make team-status-write

