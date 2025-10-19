# Data Protection Impact Assessment (DPIA) Template

> Complete this document for any feature that introduces new processing of personal data or changes retention/handling of existing datasets. Store the signed DPIA in `docs/security/dpia-records/` along with Jira ticket references. See `docs/security/dpia-records/telephony-parity.md` for an example pilot assessment.

## 1. Summary

- **Feature / Project Name:**  
- **Owner(s):**  
- **Date:**  
- **Product / Engineering Tickets:**  

## 2. Purpose & Scope

- **Purpose of processing:**  
- **Lawful basis:** (e.g., consent, legitimate interest, contract)
- **Systems / services involved:**  
- **Aggregate data volume:** (estimated records per day)

## 3. Data Inventory

| Data Item | Classification (Public/Internal/Confidential/PHI) | Source | Storage Location | Retention |
|-----------|----------------------------------------------------|--------|------------------|-----------|
|           |                                                    |        |                  |           |

See `docs/security/DATA_CLASSIFICATION.md` for categories and retention defaults.

## 4. Data Flow & Controls

- **Describe the data flow:** Include references to `docs/security/THREAT_MODEL.md` components or attach an updated diagram.
- **Transport security:** (TLS/mTLS, pinning requirements)  
- **Ingress validation:** (schema validation, consent checks)  
- **Authorisation / Access Controls:** (scopes, roles, RBAC)  
- **Logging & Monitoring:** (hashing, audit trails)  

## 5. Risk Assessment (STRIDE / Privacy Risks)

| Risk ID | Description | Likelihood | Impact | Mitigations | Owner | Status |
|---------|-------------|------------|--------|-------------|-------|--------|
|         |             |            |        |             |       |        |

Consider privacy-specific risks: re-identification, data minimisation gaps, unauthorised access, retention overrun, lawful basis misalignment.

## 6. Third Parties / Sub-processors

- **Vendors involved:** (link to vendor risk assessments)  
- **Data transfer locations:** (UK/EU/US/etc.)  
- **Contracts / DPAs in place:**  

## 7. Consultation

- **DPO / Legal review date & outcome:**  
- **Security review:**  
- **Clinical Safety review (if applicable):**  

## 8. Actions & Decisions

- **Approved mitigations / remediation tasks:**  
- **Residual risks accepted by:**  
- **Next review date:** (default annually or upon material change)  

## Sign-off

| Role | Name | Signature / Date |
|------|------|------------------|
| Product / Engineering Owner |  |  |
| Data Protection Officer |  |  |
| Security |  |  |
| Clinical Safety (if required) |  |  |
