# Privacy Review Checklist

Use this checklist during design reviews, PRs, and release readiness to ensure privacy controls are applied consistently. Answer **Yes/No/N/A** and capture follow-up actions.

1. **Purpose & Lawful Basis**
   - [ ] Feature purpose documented; lawful basis confirmed (consent/contract/legitimate interest).
   - [ ] DPIA initiated or existing DPIA updated (attach ticket).

2. **Data Minimisation**
   - [ ] Only required fields are collected; optional PHI removed or defaulted to off.
   - [ ] Analytics/logging paths hash or redact identifiers (`hashIdentifier`, `hashPatientId`).
   - [ ] Retention aligns with `privacy_policy.retention_days` or stricter requirement.

3. **Consent & Transparency**
   - [ ] User-facing copy updated (portal, telephony) to reflect new processing.
   - [ ] Consent headers/flags propagated across services and stored in audit trail.

4. **Security Controls**
   - [ ] Transport security matches policy (TLS/mTLS). See `docs/security/TLS_POLICY.md`.
   - [ ] Authentication/authorisation scopes verified; JWT checks follow `OIDC_JWT_HARDENING.md`.
   - [ ] Secrets managed via Vault; no plain-text credentials in repo or configs.

5. **Storage & Access**
   - [ ] Data classification recorded in `DATA_CLASSIFICATION.md` mapping.
   - [ ] Storage location documented (region, replica, backups) with WORM/Audit requirements met.
   - [ ] Purge or anonymisation job created where needed (feature store, DLQ).

6. **Third Parties**
   - [ ] Vendor assessment completed / in progress (if new sub-processor).
   - [ ] Contracts & DPAs updated; data transfer location noted.

7. **Testing & Validation**
   - [ ] Unit/integration tests cover allowed/denied cases (consent missing, invalid JWT, expiry).
   - [ ] Negative tests confirm masking/logging behaviour.

8. **Incident Response**
   - [ ] IR plan updated (SEC-02.10) with specific runbooks or playbooks if new data paths introduced.

Record any “No” responses as remediation tasks before release. Attach the completed checklist to the corresponding PR or design doc.
