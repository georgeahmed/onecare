# DPIA Record – Telephony Parity Metrics

- **Date:** 2025-10-18
- **Owners:** Security, Telephony Platform, Data Engineering
- **Tickets:** SEC-02.3, TEL-04.2
- **Purpose:** Process call metadata (duration, call quality, queue times) for parity monitoring without exposing PHI.

## Summary

- Limited dataset to call start/end timestamps, anonymised caller ID (SHA-256 with environment salt), queue metrics, and agent IDs.
- No transcripts or call audio retained in analytics pipeline; raw audio handled under Ambient Scribe policy.
- Retention set to 365 days for parity metrics; aggregated dashboards only.

## Risks & Mitigations

| Risk | Mitigation | Status |
|------|------------|--------|
| Re-identification via call IDs | Hash identifiers; drop last 4 digits of CLI before hashing | Implemented |
| Access to granular queues | RBAC on analytics warehouse; per-team views | Implemented |
| Data retention drift | Warehouse TTL job aligned to `DATA_CLASSIFICATION` policy | Scheduled (DE-21) |

## Approvals

| Role | Name | Date |
|------|------|------|
| Product Owner | A. Khan | 2025-10-18 |
| Security | L. Bryant | 2025-10-18 |
| DPO | S. Morgan | 2025-10-18 |
