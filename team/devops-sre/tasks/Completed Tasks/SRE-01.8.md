Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.7.md) | [Next](SRE-01.9.md)

Task: SRE-01.8 — Supply chain: SBOM + vulnerability scanning in CI

Context
- Generate Software Bills of Materials (SBOM) and perform vulnerability scans in CI with enforceable thresholds and exceptions policy.
- Current state: `.github/workflows/ci.yml` runs `npm audit`, `pip-audit`, `trivy`, and `license-checker`, but every step uses `continue-on-error` and no SBOM artefacts or exception workflow exist.

Files
- .github/workflows/ci.yml
- docs/SECURITY.md (update with policy and exception process)
- scripts/sbom-generate.sh (new)

Steps
1) Add SBOM generation (e.g., Syft/CycloneDX) for Node and Python dependencies; store artefacts per build (upload + checksum).
2) Harden vulnerability & license scanning: drop `continue-on-error`, enforce severity thresholds via shared config, add allowlist/expiry metadata, and fail PRs on policy breaches.
3) Document the exception intake/approval process, storage of SBOMs, and redaction requirements in `docs/SECURITY.md`; include sample GitHub comment template for approved waivers.

Acceptance Criteria
- CI produces SBOM artifacts per build; vulnerability scan step enforces thresholds; exceptions documented.

Validate
- Open a PR with a known vulnerable dependency; observe CI failure; add a justified exception and observe pass (if policy allows).

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.8' && make team-status-write
