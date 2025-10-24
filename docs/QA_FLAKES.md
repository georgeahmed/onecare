# QA Flake Detection & Quarantine Policy

Reliable feedback loops require stable tests. This document outlines how we detect, triage, and quarantine flaky tests in CI and locally.

## CI Retry & Reporting
- `node scripts/ci/run-vitest-flake-check.mjs` wraps Vitest in CI.
  - Runs the full suite once, then re-runs failing files up to `CI_FLAKE_RETRIES` (default: 2).
  - Records every attempt under `artifacts/qa/test-matrix.json` and surfaces flaky tests in `artifacts/qa/flaky-tests.json`.
  - Persistent failures after retries break the build. Flakes that eventually pass mark the workflow yellow with a warning banner.
  - If Vitest exits non-zero without producing a JSON report (for example, configuration/runtime errors), the wrapper now fails fast so the pipeline never silently passes.
- Artifacts are uploaded as `qa-vitest-flakes` on every CI run (pass or fail). Download them to see which tests retried, durations, and failure messages.
- For pull requests, tag the owning engineer/team when a flake appears. The matrix includes full test names to ease ownership lookup.

## Quarantining a Test
1. Wrap the offending test (or suite) with the helper in `qa/test-helpers/quarantine.ts`:
   ```ts
   import { quarantine } from '../test-helpers/quarantine';

   quarantine('triage smoke under network jitter', async () => {
     // flaky test body
   });
   ```
   - The helper prefixes the name with `[quarantine]` automatically and skips execution unless `VITEST_RUN_QUARANTINE=true`.
2. Add a TODO comment with the tracking issue and target removal date (within two sprints).
3. Submit a follow-up fix; quarantined tests are a stopgap only. Track the cleanup issue in the team status doc and revisit every sprint review.
4. To run quarantined suites locally/CI, set `VITEST_RUN_QUARANTINE=true npm test` or invoke a specific file.

> **Note:** Avoid marking whole files as quarantine unless every test inside flakes together. Keep the blast radius small.

## Local Stress Harness
Use the stress runner to reproduce edge conditions:
```bash
node qa/tools/stress-test.mjs qa/e2e/dlq.spec.ts --runs 50 --pattern "replay"
```
- Defaults to 20 iterations. Fails fast on the first failing run.
- Pass `--help` for full usage. Works with multiple files and `--testNamePattern` filters.

## Triage & Tracking Checklist
- [ ] Pull CI artifacts and confirm flake signature (same stack/error across attempts?).
- [ ] Check recent merges touching the failing area.
- [ ] Assess quarantine vs. immediate fix. Quarantine only when the root cause cannot be addressed within one working day.
- [ ] File/attach an issue with reproduction steps and artifact references.
- [ ] Remove the quarantine helper once fixed and verify with `node qa/tools/stress-test.mjs ...` (targeting at least 50 passes).

Keeping the loop tight: reproducible stress runs + explicit quarantine tags ensure flakes do not linger and telemetry stays green.
