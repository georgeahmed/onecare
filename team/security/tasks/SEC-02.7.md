Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.6.md) | [Next](SEC-02.8.md)

Task: SEC-02.7 — SAST/DAST gates (Semgrep/CodeQL; OWASP ZAP)

Context
- Add static/dynamic analysis gates to CI to catch common vulnerabilities early.

Files
- .github/workflows/ci.yml (extend)
- docs/security/APPLICATION_SECURITY.md (new)

Steps
1) Integrate Semgrep/CodeQL with a basic ruleset; store SARIF reports; soft‑fail initially.
2) Add a simple OWASP ZAP baseline scan for HTTP services (staging) with a safe site list; capture reports.
3) Document false positive handling and escalation process.

Acceptance Criteria
- SAST/DAST configured; reports produced; policy documented.

Validate
- Run CI; review reports.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.7' && make team-status-write

