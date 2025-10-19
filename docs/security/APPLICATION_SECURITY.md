# Application Security Testing

Last updated: 2025-10-18  
Owners: Security, DevOps SRE, Service Leads

## Overview

This document describes the static and dynamic application security testing (SAST/DAST) gates integrated into CI/CD.

## Static Application Security Testing (SAST)

- **Tools:** Semgrep (`returntocorp/semgrep-action`) and GitHub CodeQL.
- **Coverage:** TypeScript/JavaScript, Python, and Dockerfiles.
- **Pipeline:** `.github/workflows/ci.yml` job `sast` runs Semgrep and CodeQL on every PR and push. SARIF reports are uploaded as artefacts for review.
- **Policies:**
  - Semgrep uses the `p/owasp-top-ten` ruleset plus repository-specific suppressions.
  - CodeQL runs default TS/JS and Python queries. Additional queries may be added via `codeql-config.yml`.
  - Findings initially fail softly with warnings; escalate to hard fail once baseline is triaged.
- **False Positives:** Track via `config/security/sast-allowlist.yml` (expiring entries). Every suppression requires justification and expiry date.

## Dynamic Application Security Testing (DAST)

- **Tool:** OWASP ZAP Baseline scan executed via `zaproxy/action-baseline`.
- **Scope:** Staging endpoints only (base URL provided via `DAST_TARGET_URL` secret). Crawl is restricted to safe paths defined in `dast-allowlist.txt` to avoid destructive operations.
- **Schedule:** Triggered on pushes to `main` and nightly via CI job `dast`. Reports uploaded as HTML + JSON artefacts.
- **Alert handling:**
  - Medium/high alerts create Jira tickets automatically (future integration). Until then, responders review artefacts and file tickets.
  - Document accepted risks and mitigations in `VULN_MANAGEMENT.md`.

## Responsibilities

- Security: maintain tooling configurations, triage high/critical findings, update rule allowlists.
- Service teams: fix findings, request suppressions with justification, confirm remediation in PRs.
- SRE: ensure ZAP target environment availability, monitor runtime impact.

## Intake & Remediation Workflow

1. Finding generated (Semgrep/CodeQL/ZAP) → artefact uploaded.
2. Security triages severity, files ticket linking to code/URL.
3. Engineering addresses issue or documents false positive with expiry.
4. Ticket closed only after verification scan passes or manual validation recorded.

## References

- `.github/workflows/ci.yml` — SAST/DAST jobs.
- `docs/security/VULN_MANAGEMENT.md` — broader vulnerability remediation policy.
- `docs/security/EGRESS_SSRF_POLICY.md` — complements SSRF guardrails checked by Semgrep.
