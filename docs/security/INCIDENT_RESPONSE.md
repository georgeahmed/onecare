# Security Incident Response Plan (IRP)

Last updated: 2025-10-18  
Owners: Security (incident commander), DevOps SRE, Communications

## Goals

- Detect, contain, and remediate security incidents efficiently.
- Maintain clear communication with stakeholders and regulators.
- Capture lessons learned to improve resilience.

## Roles

- **Incident Commander (IC):** Coordinates response, decision-making (Security lead).
- **Deputy IC:** Backup when IC unavailable.
- **SRE Lead:** Handles infrastructure containment/recovery.
- **Product/Service Owner:** Assesses customer impact.
- **Communications:** Prepares internal/external messaging.
- **Recorder:** Maintains timeline and evidence.

## Severity Levels

| Level | Description | Target Initial Response |
|-------|-------------|-------------------------|
| Sev0 | Ongoing compromise, data exfiltration, active RCE | Immediate (pager) |
| Sev1 | Suspected breach, critical vulnerabilities exploitable | ≤15 minutes |
| Sev2 | Contained issue, limited impact | ≤1 hour |
| Sev3 | Low-risk alert / informational | Next business day |

## Lifecycle

1. **Detection:** Alert via monitoring, third-party notification, or manual report. Log in incident tracker (Jira/Incident.io).
2. **Assessment:** IC determines severity, scope, affected systems/data. Engage stakeholders.
3. **Containment:** Disable affected accounts, isolate hosts, revoke credentials, block network traffic as needed.
4. **Eradication & Recovery:** Patch vulnerabilities, restore from backups, validate integrity, monitor for reoccurrence.
5. **Communication:** Send updates every 30 minutes (Sev0/1) to #incident channel and leadership. External comms via Communications lead.
6. **Post-Incident Review:** Within 72 hours. Document timeline, root cause, corrective actions, lessons learned. Update runbooks/policies.

## Drills

- Tabletop exercises at least twice per year (simulate breach and credential compromise scenarios). Track outcomes and action items in the security backlog.
- Coordinate with SRE and product teams; include data protection officer when PHI involved.

## Evidence Handling

- Retain logs, audit entries, and relevant artefacts in secure storage (WORM). Use timestamps in UTC.
- Preserve affected systems as needed for forensics; avoid destructive changes before capture.

## Notification Obligations

- **Internal:** Leadership, legal, clinical safety, customer success.
- **External:** Regulators (e.g., ICO) within statutory timelines if personal data breach confirmed; partners/customer notifications per contracts.

## References

- `docs/security/AUDIT_POLICY.md` — ensure audit events capture actions during incident.
- `docs/security/VULN_MANAGEMENT.md` — follow-up remediation tracking.
- `docs/security/SECRETS_POLICY.md` — credential rotation during containment.
