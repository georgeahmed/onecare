Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.14.md) | [Next](SRE-01.16.md)

Task: SRE-01.15 — Supply chain security (image signing/provenance, vuln/license scans)

Context
- Improve software supply chain security: sign container images, attach provenance, and scan for vulnerabilities and license issues in CI.
- Current state: the CI workflow builds images but only runs best-effort scans (`npm audit`, `pip-audit`, `trivy fs`) with `continue-on-error`; there is no image signing, provenance, or verification step.

Files
- .github/workflows/ci.yml, cd.yml
- docs/SECURITY.md (supply chain)
- scripts/ci/*
- docs/USAGE.md (pipeline section)

Steps
1) Integrate `cosign` (sigstore) in the image build job, publish signatures + provenance (SLSA/SBOM references), and store signing keys in the chosen secrets manager.
2) Run container image scans (Trivy/Grype) post-build with enforced severity & license policies; plumb allowlist/expiry handling and remove `continue-on-error`.
3) Document verification workflow (pre-deploy signature verification, policy-controller integration) and key rotation/escrow in `docs/SECURITY.md` + `docs/USAGE.md`.

Acceptance Criteria
- Images signed; scan reports attached; docs for verification exist.

Validate
- Build pipeline shows signed images; scan reports generated; manual `cosign verify` succeeds.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.15' && make team-status-write
