# QA Fixture Changelog

## 2025-02-15 — QA-01.17
- Created anonymized fixture sets for portal submissions, triage inputs, tasks, bookings, pharmacy referrals, ICS referrals, and telephony transcripts under `qa/fixtures/anonymized/`.
- Seeded hermetic environment data for mock safety gate, scribe, and mock FHIR services (`qa/fixtures/seeds/*`).
- Introduced reusable Fast-Check generators in `qa/fixtures/generators.ts` for contract and property tests.
- Established rotation and review guidance in `docs/QA_DATA.md`.
