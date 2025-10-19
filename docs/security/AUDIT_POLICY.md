# Audit Logging Policy

Last updated: 2025-10-18  
Owners: Security, DevOps SRE, Platform Engineering

## Objectives

Capture tamper-evident audit logs for security-sensitive actions while avoiding PHI exposure.

## Required Events

| Category | Events | Minimum Fields |
|----------|--------|----------------|
| Authentication | Login success/failure, MFA enrollment/disable | timestamp, actor (hashed), outcome, IP/correlation ID |
| Authorisation | Role/permission changes, consent grants/revocations | timestamp, actor, target, change summary |
| Data Access | Viewing/modifying PHI (FHIR resources, referrals, transcripts) | timestamp, actor hash, resource type, action, request correlation |
| Operational | Deployment, configuration changes, feature flag toggles | timestamp, actor, environment, change ID |
| Safety Decisions | Safety gate outcomes, overrides | timestamp, actor (hashed), decision, reason code |
| Booking/ICS Events | Slot bookings, referral routing, DLQ replay | timestamp, action, slot/referral identifiers (hashed), correlation ID |

All identifiers must use deterministic hashes (`hashIdentifier`) or pseudonyms; avoid raw patient data. Payloads limited to metadata necessary for traceability.

## Storage & Retention

- Audit logs written to append-only storage (e.g., Loki WORM bucket, Elasticsearch with write-once policy).
- Retention: ≥10 years (aligned with `privacy_policy.retention_days`).
- Backups verified quarterly; integrity checks (SHA-256) recorded.

## Delivery Pipeline

1. Services emit structured audit events using `@onecare/observability` audit helpers.
2. Events buffered via AuditSpool; on failure, send to DLQ (`Topics.audit.event`).
3. Consumer writes to WORM storage; failures trigger alerts and fallback spool.

## Access & Monitoring

- Access restricted to security and compliance roles; read-only accounts with MFA.
- Every access logged (meta-audit). Quarterly review per `ACCESS_REVIEWS.md`.
- Alerts for missing ingest, spool backlog, or unusual volume.

## Redaction Guidelines

- Hash patient IDs and use truncated slot/referral IDs.
- Do not include narratives, transcripts, or free text in audit records.
- For partner identifiers, include hashed ID and partner slug.

## Validation

- Unit tests confirm audit events omit PHI and include required fields.
- Penetration testers may request audit evidence; ensure retrieval process documented.

## References

- `docs/security/INCIDENT_RESPONSE.md` — audits used during investigations.
- `docs/security/VULN_MANAGEMENT.md` — track vulnerabilities identified in audit pipeline.
