# QA Test Data Management

Accurate, privacy-safe fixtures keep contract and E2E coverage deterministic. Follow this guidance whenever fixtures change or new scenarios are added.

## Directory Structure
- `qa/fixtures/anonymized/` — versioned sample payloads (portal submissions, triage inputs, tasks, bookings, referrals, telephony transcripts).
- `qa/fixtures/seeds/` — seed datasets consumed by the hermetic compose profile (`./qa/env/seed.sh`).
- `qa/fixtures/generators.ts` — shared Fast-Check arbitraries and helper generators.
- `qa/fixtures/CHANGELOG.md` — append every fixture update with the task/issue ID and a quick summary.

## Rotation & Review Cadence
- Revisit fixtures **at least once per release train** or whenever a contract/schema meaningfully changes.
- When updating:
  1. Edit the anonymized JSON first. Keep identifiers synthetic (`patient-alpha`, `call-bravo-001`) and avoid PHI/PII.
  2. Run `./qa/env/seed.sh` to sync `qa/env/mock-data/*` and verify mocks respond with the new data.
  3. Update `qa/fixtures/CHANGELOG.md` with the date, task, and key changes.
  4. Execute `npm run test:e2e` and `node scripts/ci/run-vitest-flake-check.mjs` locally to confirm stability.
  5. For schema changes, rerun `npm run codegen` and adjust generators if new fields appear.

## Sanitization Checklist
- No real names, MRNs, addresses, phone numbers, or free-text copied from production.
- `patientId`, `callId`, etc. should follow neutral patterns (`patient-alpha`, `call-bravo-001`).
- Timestamps stay within 2024–2026 to avoid surprises in relative assertions.
- Inspector command: `rg --ignore-case "(mrn|ssn|dob|nhs)" qa/fixtures` should return nothing.

## Generators & Property Tests
- Reuse arbitraries from `qa/fixtures/generators.ts` to keep edge cases consistent across tests.
- When a new contract is introduced:
  - Add a generator for valid payloads and a companion `NegativeCase` set for near-misses.
  - Export them for Vitest suites so both property tests and scenario tests share the same source of truth.

## Seed Data Updates
- `qa/fixtures/seeds/` drives the hermetic mocks (`mock-safety-gate`, `mock-scribe`, `mock-fhir`).
- After touching seed files, run `./qa/env/seed.sh` and hit the health endpoints:
  ```bash
  curl -s http://127.0.0.1:5011/health | jq
  curl -s http://127.0.0.1:5012/health | jq
  curl -s http://127.0.0.1:9500/health | jq
  ```
- Commit both the fixture changes and the updated changelog in the same patch.

Keeping fixtures tidy and traceable ensures contract tests flag real regressions, not stale data drift.
