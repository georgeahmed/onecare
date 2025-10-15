Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.4.md) | [Next](SEC-01.6.md)

Task: SEC-01.5 — Secrets scanning in CI and pre-commit

Context
- Prevent accidental secret leakage by scanning commits and PRs with tools like gitleaks or trufflehog.

Files
- .github/workflows/ci.yml (extend)
- .pre-commit-config.yaml (new)

Steps
1) Add gitleaks/trufflehog step in CI to scan diffs; fail on high-confidence findings.
2) Provide a pre-commit config to run scans locally; document suppressions/false positives workflow.

Implementation Notes
- `.github/workflows/ci.yml` promotes the gitleaks job to a blocking scan aligned with the repo baseline.
- `.pre-commit-config.yaml` adds the same gitleaks hook so engineers catch issues locally before pushing.

Acceptance Criteria
- Scanning enabled; documentation on handling findings; pre-commit hook available.

Validate
- Simulate a test secret; observe detection.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SEC-01.5' && make team-status-write
