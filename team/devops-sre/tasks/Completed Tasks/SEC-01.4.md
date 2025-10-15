Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.3.md) | [Next](SEC-01.5.md)

Task: SEC-01.4 — Dependency scanning gates and license policy

Context
- Enforce dependency scanning for Node/Python and a basic license policy to avoid problematic dependencies.

Files
- .github/workflows/ci.yml (extend)
- docs/SECURITY.md (dependencies section)

Steps
1) Integrate `npm audit`/`pnpm audit` and `pip-audit` in CI; capture reports; soft-fail at first.
2) Define a license allowlist (e.g., MIT, Apache-2.0, BSD) and flag unknown/forbidden licenses.
3) Document remediation workflow and exception process.

Implementation Notes
- `.github/workflows/ci.yml` now runs `npm audit`, `pip-audit`, and a license allowlist check, uploading JSON artefacts for review.
- `docs/SECURITY.md` documents the allowlist, triage process, and expectations for vulnerability remediation.

Acceptance Criteria
- Scans run; license policy documented; exceptions tracked.

Validate
- Run CI; review reports.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SEC-01.4' && make team-status-write
