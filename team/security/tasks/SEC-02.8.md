Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.7.md) | [Next](SEC-02.9.md)

Task: SEC-02.8 — Vulnerability management (CVSS thresholds; triage/patch SLAs)

Context
- Define how vulnerabilities are triaged and remediated, with clear SLAs and exception handling.

Files
- docs/security/VULN_MANAGEMENT.md (new)

Steps
1) Set CVSS thresholds for action (e.g., Critical/High patched in 7/14 days); define ownership and tracking.
2) Document triage workflow (intake, assess, remediate, verify, close) and exception process.
3) Integrate with existing scans (dependency/image) and ticketing.

Acceptance Criteria
- Policy published; SLAs clear; integration points noted.

Validate
- Dry‑run a mock vulnerability; verify workflow steps.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.8' && make team-status-write

