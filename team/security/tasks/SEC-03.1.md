Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.9.md) | [Next](SEC-03.2.md)

Task: SEC-03.1 — Secure SDLC policy & PR checklist integration

Context
- Embed security into day‑to‑day development via a concise secure SDLC policy and PR checklist enforced in reviews/CI.

Files
- docs/security/SECURE_SDLC.md (new)
- .github/pull_request_template.md (new or extend)

Steps
1) Write SECURE_SDLC.md covering: threat modeling touchpoints, contract‑first changes, validation/guardrails, logging privacy, SSRF/CSP, and secrets.
2) Add PR checklist: contracts updated/codegen, validators present, error envelopes safe, no PHI logs, timeouts/retries/CB, SSRF allowlist, CSP implications.
3) Reference the checklist in AGENTS.md and engineering docs.

Acceptance Criteria
- Policy and PR template published; reviewers and CI reference them.

Validate
- Dry‑run in a PR; ensure checklist renders and is actionable.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.1' && make team-status-write

