Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.16.md) | [Next](SRE-01.2.md)

Task: SRE-01.17 — CI/CD pipeline (build→test→codegen:check→SBOM→scan→docker push→staging canary→prod promote/rollback)

Context
- Implement an end‑to‑end CI/CD that enforces quality gates (typecheck/tests/codegen), supply chain security (SBOM + vulnerability/license scans), and safe rollout (staging canary with quick rollback).
- Current state: `.github/workflows/ci.yml` already runs codegen, typecheck, tests, perf smoke, and optional image builds, but lacks SBOM artefacts, signed images, or any CD workflow (`cd.yml` absent).

Files
- .github/workflows/ci.yml (update)
- .github/workflows/cd.yml (new)
- scripts/sbom-generate.sh (new)
- docs/USAGE.md (update with pipeline commands)
- docs/RELEASE_READINESS.md (update gates)

Steps
1) Extend CI to emit SBOM artefacts (Node + Python), enforce scan thresholds, and store outputs for downstream provenance/signing steps.
2) Integrate image signing + provenance attestations (cosign/SLSA) before pushing images, ensuring the signatures are verified during deploy.
3) Author `cd.yml` that deploys to staging (canary + smoke tests), gates promotion on SLO guardrails + manual approval, and supports automated rollback.
4) Update `docs/USAGE.md` and `docs/RELEASE_READINESS.md` with pipeline stages, required secrets, rollback guidance, and verification steps.

Acceptance Criteria
- CI fails on drift/security violations; SBOMs + signatures stored as artefacts.
- CD workflow promotes staging → production with canary + rollback automation and documented operator steps.

Validate
- Run CI on a PR to confirm SBOM + signing stages execute; dry-run CD to staging namespace and exercise rollback path.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.17' && make team-status-write
