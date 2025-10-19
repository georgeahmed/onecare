# Supply Chain Security Policy

Last updated: 2025-10-18  
Owners: Security, DevOps SRE, Build/Release Engineering

## Objectives

Guarantee integrity and provenance of software artefacts from source to production deployment.

## Requirements

1. **SBOM Generation**
   - Node & Python SBOMs generated each CI run via `scripts/sbom-generate.sh` (CycloneDX JSON + SHA-256 checksums).
   - Store SBOM artefacts for ≥90 days; attach to releases.
2. **Image Signing & Provenance**
   - Container images built in CI (`docker-images` job) are signed with cosign and have SLSA provenance attestations.
   - Public key stored in GitHub secrets (`COSIGN_PUBLIC_KEY`) and referenced by CD workflow.
3. **Admission Control**
   - Production deployments must verify cosign signatures (CD workflow) before applying manifests.
   - Kubernetes admission policy (OPA/Gatekeeper or Kyverno) to enforce signature verification is planned; tracked under `SRE-TRACK-228`.
4. **Dependency Hygiene**
   - Use npm/pip lock files; run `npm audit`, `pip-audit`, `trivy fs` each CI cycle.
   - Block builds that introduce critical/high vulnerabilities without approved exception (`VULN_MANAGEMENT.md`).
5. **Artefact Storage**
   - Registries: `ghcr.io/onecare/*`. Access via least privilege tokens (`SECRETS_POLICY.md`).
   - Protect branches (review required) and enable required status checks (CI jobs, SAST, DAST).

## Verification

- CD workflow (`.github/workflows/cd.yml`) executes `cosign verify` for orchestrator/booking/ics images prior to staging/prod rollout.
- Admission controller (future) to enforce signature verification cluster-side.
- Periodic spot checks: run `cosign verify` and `cosign attest` manually each quarter.

## Exceptions

- Third-party images must supply SBOMs and signatures; otherwise, mirrored and scanned before use.
- Temporary signature bypass requires Security approval with expiry ≤30 days.

## References

- `.github/workflows/ci.yml`, `.github/workflows/cd.yml` — pipeline implementation.
- `docs/security/APPLICATION_SECURITY.md` — SAST/DAST context.
- `docs/security/VULN_MANAGEMENT.md` — remediation of supply-chain findings.
