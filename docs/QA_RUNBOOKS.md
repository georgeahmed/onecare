# QA Runbooks & Coverage Matrix

## Core Commands
| Scope | Command | Notes |
| --- | --- | --- |
| Hermetic environment | `docker compose --profile test up qa-test-env` | Starts mocks + NATS |
| Seed data | `./qa/env/seed.sh` | Sync anonymized fixtures with mocks |
| Contract tests | `NODE_ENV=test npm run test:contracts` | Includes property + snapshot suites |
| Accessibility smoke | `NODE_ENV=test npm run test:e2e -- --run qa/e2e/a11y.spec.ts` | Writes reports to `artifacts/qa/a11y/` |
| DLQ replay drill | `NODE_ENV=test npm run test:e2e -- --run qa/e2e/dlq-replay.spec.ts` | Validates idempotent replay path |
| Chaos drills | `./scripts/chaos/inject.sh [all|bus|fhir]` | Exercises bus/FHIR circuit scenarios |
| Stress a flaky test | `node qa/tools/stress-test.mjs <spec> --runs 50` | Reproduces suspected flakes locally |

All QA npm scripts set `VITEST_SCOPE` automatically, so the `qa/**` suites run without editing the global Vitest configuration.

## Coverage Matrix
| System | Contract Tests | E2E / Scenario | Fault & Chaos | Accessibility | Perf / Load |
| --- | --- | --- | --- | --- | --- |
| Orchestrator | `qa/contracts/property.spec.ts`, snapshots | DLQ path (`qa/e2e/dlq.spec.ts`) | Chaos suite (bus outage, FHIR CB) | — | `scripts/perf/booking_flow.js` |
| Booking | Appointment schema snapshot | Booking flow selection (`qa/e2e/a11y.spec.ts`) | Chaos (bus/fallback) | Axe (`booking-flow.html`) | `scripts/perf/booking_flow.js` |
| Triage | Triage input schema + generators | Intake submission coverage (`qa/e2e/a11y.spec.ts`) | Chaos (safety fallback) | Axe (`portal-intake.html`) | `scripts/perf/triage_flow.js` |
| Pharmacy | Referral schema/property | — | Chaos (DLQ replay) | — | — |
| ICS Hub | Referral request/ack schema | DLQ replay E2E | Chaos (DLQ replay) | — | — |
| Telephony | Call transcript schema | Telephony parity (`qa/e2e/telephony_parity.spec.ts`) | Chaos (circuit breaker) | — | `node scripts/perf/telephony_parity.js` |

Legend: ✓ coverage delivered by listed suites/scripts. Empty cell indicates gap or covered elsewhere.

## Troubleshooting Drill
1. **Contract failure** — run the specific spec under `qa/contracts/`, inspect `artifacts/qa/test-matrix.json` for the failing case, and check `qa/fixtures/generators.ts` for drift.
2. **Flake surfaced in CI** — download the `qa-vitest-flakes` artifact, reproduce with `node qa/tools/stress-test.mjs`, quarantine via `quarantine()` helper if needed, and link to the tracking issue.
3. **Chaos regression** — rerun `npm run test:e2e -- --run qa/e2e/chaos`, review timings printed in the vitest output, and confirm SLO budgets (e.g., retries bounded under 500 ms for bus outage).

Keep this runbook in sync with new suites or tooling; when adding a script/spec, update the table above so onboarding engineers know where coverage lives.
