# Secure Software Development Lifecycle (SDLC)

Last updated: 2025-10-18  
Owners: Security, Engineering Leads

## Lifecycle Stages

1. **Plan**
   - Capture requirements, privacy impact (initiate DPIA if personal data scope changes).
   - Update threat model (`docs/security/THREAT_MODEL.md`) for major architectural changes.
2. **Design**
   - Review data classifications, retention, and minimisation implications.
   - Identify security controls (auth, rate limits, audit logging, SSRF allowlists) and document in PR/design doc.
3. **Implementation**
   - Follow secure coding guides (`SECURE_CODING_NODE.md`, `SECURE_CODING_PY.md`).
   - Validate inputs, enforce timeouts/retries, redact logs, avoid secrets in code.
   - Write unit tests covering positive/negative security cases.
4. **Verification**
   - Run CI (typecheck, tests, SAST, DAST). Address or triage findings before merge.
   - Update docs (USAGE, READMEs, policies) and ADRs as necessary.
5. **Release**
   - Ensure CD pipeline passes (signature verification, smoke tests).
   - Update Release Readiness checklist.
6. **Operate**
   - Monitor metrics, logs, and security alerts; participate in incident response drills.
   - Perform access reviews and rotation per schedule.

## PR Checklist Integration

All pull requests must confirm the following (see `.github/pull_request_template.md`):

- [ ] Contracts/validators updated and codegen run.
- [ ] Security: inputs validated, SSRF-safe HTTP clients, timeouts/retries set, no PHI/secrets in logs, audit events present where required.
- [ ] Tests cover security-sensitive paths (auth, error handling, negative cases).
- [ ] Documentation updated (Runbooks, policies, READMEs) when behavior changes.
- [ ] SAST/DAST findings triaged or suppressed with justification.
- [ ] Secrets sourced via Vault/environment; rotations scheduled if needed.

## Roles & Responsibilities

- **Developers:** Follow guidelines, update checklists, fix findings.
- **Reviewers:** Enforce checklist items, request security review for high-impact changes.
- **Security:** Maintain policies, assist with threat modelling, triage scanner findings.
- **SRE:** Ensure infra guardrails (NetworkPolicies, mTLS, logging) remain effective.

## References

- Secure coding guides: `SECURE_CODING_NODE.md`, `SECURE_CODING_PY.md`
- Security policies: `SECRETS_POLICY.md`, `SUPPLY_CHAIN.md`, `EGRESS_SSRF_POLICY.md`, `VULN_MANAGEMENT.md`
- Training: `TRAINING.md`
