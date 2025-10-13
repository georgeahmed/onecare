Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.1.md) | [Next](SEC-03.3.md)

Task: SEC-03.2 — Code scanning (Semgrep/CodeQL) curated rules + severity gates

Context
- Strengthen code scanning with curated rulesets and severity thresholds; produce SARIF artifacts in CI.

Files
- .github/workflows/ci.yml (extend)
- docs/security/CODE_SCANNING.md (new)

Steps
1) Enable Semgrep/CodeQL with a curated ruleset tailored to Node/TS/Python and FastAPI patterns; exclude known false positives.
2) Publish SARIF artifacts; fail CI on High/Critical (soft‑fail initially); track ignored items with reasons.
3) Document ruleset ownership and update cadence.

Acceptance Criteria
- Scanners run with curated rules; policy documented; SARIF artifacts in CI.

Validate
- CI run shows scan results; verify gating behavior.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.2' && make team-status-write

