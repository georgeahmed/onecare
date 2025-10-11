Task: SRE-01.9 — CI/CD pipeline: build→test→codegen:check→SBOM→scan→docker push→staging canary→prod promote/rollback

Context
- Implement a robust GitHub Actions pipeline that builds/tests, checks codegen drift, generates SBOM, scans images, pushes to registry, and deploys with canary and rollback.

Files
- .github/workflows/ci.yml
- .github/workflows/cd.yml (new)
- docs/USAGE.md (CI/CD overview)

Steps
1) CI: add jobs for typecheck/test/lint/codegen:check (TS + Py), and cache npm/pip. Generate SBOM (CycloneDX) and upload as artifact.
2) Security: run `trivy` or similar to scan built images; run `npm audit`/`pip-audit`; soft‑fail initially with report artifacts.
3) CD: on main merges, build and push images; deploy to staging with a canary percentage; run smoke tests; allow manual promotion to prod.
4) Rollback: implement automatic rollback on health/readiness failures; keep previous image tags.

Acceptance Criteria
- Pipelines green on current code; SBOM and scan reports present; deployment gates in place; rollback verified in staging.

Validate
- Dry‑run CI locally if possible; review workflow syntax; simulate a staging deploy.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.9' && make team-status-write

