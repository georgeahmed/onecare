# Compliance Mapping (DSPT, DCB 0129/0160)

Last updated: 2025-10-18  
Owners: Security, Clinical Safety, Governance

## Control Mapping

| Requirement | Control | Evidence | Owner | Status |
|-------------|---------|----------|-------|--------|
| DSPT: Access control | RBAC, quarterly access reviews | `docs/security/ACCESS_REVIEWS.md`, review records | Security | ✅ Ongoing |
| DSPT: Audit | Audit logging policy & WORM storage | `docs/security/AUDIT_POLICY.md`, Loki WORM config | DevOps SRE | ✅ |
| DSPT: Incident response | IRP and drills | `docs/security/INCIDENT_RESPONSE.md`, tabletop notes | Security | ☑️ (next drill Jan 2026) |
| DSPT: Data minimisation | Data classification policy | `docs/security/DATA_CLASSIFICATION.md`, retention configs | Product teams | ✅ |
| DCB 0129: Clinical safety risk mgmt | Safety case, testing | Clinical Safety documentation (external) | Clinical Safety | 🔄 In progress |
| DCB 0160: Manufacturer obligations | Risk assessments, sign-off | `docs/security/THREAT_MODEL.md`, DPIA records | Product, Security | 🔄 |
| Vendor management | Vendor assessments | `docs/security/VENDOR_RISK.md` | Security | ✅ |
| Training | Security/privacy training | `docs/security/TRAINING.md`, records | People Ops | ✅ |

Legend: ✅ implemented, ☑️ scheduled/partially complete, 🔄 in progress.

## Evidence Collection Plan

- **Quarterly:** Access review exports, backup verification logs, audit integrity proofs.
- **Bi-annually:** Incident response drill reports, vendor reassessments.
- **Annually:** Training completion records, DPIA updates, clinical safety assessments.

Store evidence under `docs/security/compliance-evidence/<year>/` with timestamps. External documents (e.g., clinical safety files) referenced with secure repository links.

## Gaps & Remediation

- DCB 0129 safety case automation pending (owner: Clinical Safety, due Q4 2025).
- Admission controller enforcement for signed images (see `SUPPLY_CHAIN.md`, tracked by SRE).
- Complete automation for vendor ticket tracking (Security backlog).

Review this mapping quarterly with Security, Clinical Safety, and Governance teams.
