# Vulnerability Management Policy

Last updated: 2025-10-18  
Owners: Security (coordination), DevOps SRE (infrastructure), Team Leads (remediation)

## Objectives

Provide a consistent process for discovering, triaging, remediating, and documenting security vulnerabilities across code, dependencies, infrastructure, and vendors.

## Severity & SLA Matrix

| Severity (CVSS) | Examples | Remediation SLA | Interim Actions |
|-----------------|----------|-----------------|-----------------|
| Critical (≥9.0) | RCE, auth bypass, leaked signing keys | 7 days (≤24h for edge-exposed) | Immediate mitigation (feature flag, network block), incident assessment |
| High (7.0–8.9) | Privilege escalation, sensitive data exposure | 14 days | Apply compensating controls, monitor logs |
| Medium (4.0–6.9) | Input validation gaps, unprivileged DoS | 30 days | Plan fix in next sprint |
| Low (<4.0) | Informational findings | 90 days | Evaluate for backlog |

SLA clock starts when a vulnerability is confirmed (triage complete). Exceptions require approval from Security and owner VP with documented expiry date.

## Workflow

1. **Discovery:** Via CI scans (Semgrep, CodeQL, Trivy, ZAP), external reports, or vendor alerts.
2. **Triage:** Security evaluates severity, impact, exploitability, and affected components. Create Jira ticket with labels (`security`, severity) and link to scan artefact.
3. **Assignment:** Tickets assigned to owning team; include remediation plan and target release.
4. **Remediation:** Implement fix, add tests, update documentation. For dependency bumps, ensure SBOM reflects new versions.
5. **Verification:** Re-run scans/tests, attach results to ticket. Peer review required.
6. **Closure:** Ticket closed after verification, release notes updated if necessary. Capture residual risk if unresolved.

## Exception Handling

- Documented in the vulnerability ticket with justification, compensating controls, and expiry (maximum 90 days).
- Review exceptions weekly in the security standup; escalate overdue items.

## Reporting & Metrics

- Track open vulnerabilities by severity, average time to remediate, and SLA breaches.
- Maintain monthly report for leadership; include status of external advisories and vendor patching.
- Integrate with `docs/SECURITY.md` dependency scanning section.

## Tools & Integrations

- CI artefacts stored under `security-reports`, `image-security-reports`, `sast-reports`, `dast-reports`.
- Use GitHub Security Advisories and Dependabot for ecosystem alerts; triage within 2 business days.
- Vendor advisories tracked via shared mailbox; log responses in each ticket.

## References

- `docs/security/APPLICATION_SECURITY.md` — SAST/DAST tooling.
- `docs/security/SUPPLY_CHAIN.md` — SBOM and signing policy.
- `docs/security/INCIDENT_RESPONSE.md` — follow-up for exploitable vulnerabilities.
