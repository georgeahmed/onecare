Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.7.md) | [Next](SRE-01.9.md)

Task: SRE-01.8 — Supply chain: SBOM + vulnerability scanning in CI

Context
- Generate Software Bills of Materials (SBOM) and perform vulnerability scans in CI with enforceable thresholds and exceptions policy.

Files
- .github/workflows/ci.yml
- docs/SECURITY.md (update with policy and exception process)

Steps
1) Add SBOM generation (e.g., Syft/CycloneDX) for Node and Python dependencies; archive as CI artifacts.
2) Add vulnerability scanning (e.g., Grype, npm audit, pip-audit) with severity thresholds; fail PRs on criticals unless approved exceptions exist.
3) Document exception request/approval process and timelines in docs/SECURITY.md; ensure scans redact secrets and avoid PHI.

Acceptance Criteria
- CI produces SBOM artifacts per build; vulnerability scan step enforces thresholds; exceptions documented.

Validate
- Open a PR with a known vulnerable dependency; observe CI failure; add a justified exception and observe pass (if policy allows).

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.8' && make team-status-write

