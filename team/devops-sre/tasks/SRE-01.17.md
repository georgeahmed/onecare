Task: SRE-01.17 — CI/CD pipeline (build→test→codegen:check→SBOM→scan→docker push→staging canary→prod promote/rollback)

Context
- Implement an end‑to‑end CI/CD that enforces quality gates (typecheck/tests/codegen), supply chain security (SBOM + vulnerability/license scans), and safe rollout (staging canary with quick rollback).

Files
- .github/workflows/ci.yml (update)
- .github/workflows/cd.yml (new)
- scripts/sbom-generate.sh (new)
- docs/USAGE.md (update with pipeline commands)
- docs/RELEASE_READINESS.md (update gates)

Steps
1) CI stages: checkout → cache deps → npm ci/pip install → npm run codegen:check → npm run typecheck && npm run test → build images.
2) Generate SBOM (syft or equivalent) and run vulnerability/license scans with policy thresholds; fail on high/critical unless allowlisted.
3) Push images to registry on main tags; sign images if supported; attach provenance.
4) CD workflow: deploy to staging namespace; run smoke (synthetic) and contract tests; gate promotion on pass + SLO guardrails.
5) Canary to production with small percentage; auto rollback on error budgets breach; provide manual approval step.
6) Document pipeline commands, required secrets, and rollback process.

Acceptance Criteria
- CI fails on typecheck/test/codegen drift or policy violations; artifacts include SBOM.
- CD performs staged rollout with observable smoke checks and rollback.

Validate
- Run CI on PR and observe gates; test CD in a sandbox cluster/namespace with dry‑run if needed.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.17' && make team-status-write

