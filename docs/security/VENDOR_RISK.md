# Vendor Risk & Third-Party Assessment

Last updated: 2025-10-18  
Owners: Security, Legal, Product Integrations

## Assessment Checklist

1. **Data Handling**
   - What data is shared (PHI/PII, anonymised data, metadata)?
   - Transmission security (TLS/mTLS)?
   - Storage: encryption at rest, retention periods, deletion guarantees.
2. **Access & Authentication**
   - Authentication method (API key, OAuth, client cert). Rotation capability.
   - Access controls for vendor staff; subcontractors/sub-processors.
3. **Security Controls**
   - Vulnerability management, pen tests, certifications (ISO27001, SOC2).
   - Incident response SLAs, breach notification timelines.
4. **Compliance & Legal**
   - Data location/jurisdiction. DSPT/NHS compliance (if applicable).
   - Data processing agreements executed and signed.
5. **Monitoring**
   - Logging available (request IDs, correlation). Rate limits and throttling controls.
6. **Contract Review**
   - Termination rights, data return/destruction clauses.
   - Liability caps, indemnification.

## Current Vendors

| Vendor | Service | Data Shared | Encryption | Retention | Last Review | Findings |
|--------|---------|-------------|------------|-----------|-------------|----------|
| GP Connect | Appointment booking | Patient identifiers, slot details | TLS + API key (mTLS planned) | 3,650 days (system of record) | 2025-10-18 | mTLS rollout task `SRE-TRACK-217` |
| ICS CPCS | Referral routing | Referrals (hashed IDs), automation tasks | TLS + client cert | 30 days in DLQ | 2025-10-18 | Ensure pinning per TLS policy |
| ASR Provider | Call audio transcription | Audio streams, transcripts | TLS 1.2, token auth | 30 days | 2025-10-18 | Enforce anonymisation pipeline |

Update this table after each vendor review; store detailed questionnaires in `docs/security/vendor-records/`.

## Remediation Tracking

- Track outstanding vendor issues in Jira with `vendor-risk` label.
- Review remediation progress monthly.

## References

- `docs/security/DPIA_TEMPLATE.md` — include vendor risk outcomes in DPIAs.
- Contracts stored in secure legal repository with cross-reference IDs.
