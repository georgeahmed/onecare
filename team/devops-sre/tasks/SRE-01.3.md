Task: SRE-01.3 — CI caching + codegen checks

Context
- Speed up CI and ensure contract/codegen gates prevent drift.

Files
- .github/workflows/ci.yml
- scripts/ci/check_contracts_sync.sh

Steps
1) Add actions/cache steps for npm and pip caches keyed by lockfiles.
2) Ensure codegen check runs on PRs with schema changes; fail if outputs not regenerated.

Acceptance Criteria
- CI speed improves; schema drift is caught by CI.

Validate
- Open PR with schema change missing codegen; CI fails as expected.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.3' && make team-status-write

