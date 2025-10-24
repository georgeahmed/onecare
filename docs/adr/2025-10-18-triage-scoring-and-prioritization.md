# ADR 2025-10-18 — Triage Scoring and Prioritisation

| Status | Accepted |
|--------|----------|
| Date   | 2025-10-18 |

## Context

The triage service receives heterogeneous submissions from multiple channels. We need a deterministic, configurable scoring pipeline that:

- Combines ML features (acuity, risk, complexity, time, capacity) using weights agreed with clinicians.
- Calibrates scores to a 0–1 range, enabling stable priority thresholds (`STAT/URGENT/SOON/ROUTINE`).
- Provides a deterministic fallback when ML signals are missing or deemed unreliable, without leaking PHI in logs/events.
- Highlights red-flag narratives and explains prioritisation through machine-readable reason codes.

## Decision

1. **Weighted linear model with calibration**
   - `computeTriageScore` multiplies each feature by config-driven weights (`triage.score_weights`) and applies optional slope/intercept plus min/max clamps (`triage.score_calibration`).
   - Scores are clamped to the calibrated bounds; clamped occurrences increment `triage.score.clamped`.

2. **Priority thresholds + epsilon bump**
   - Thresholds live under `priority_thresholds` (STAT/URGENT/SOON/ROUTINE). Values are clamped to `[0,1]` and enforced in descending order.
   - When a score is within `triage.priority_tiebreaker.epsilon` of the next threshold and the acuity feature exceeds `triage.priority_tiebreaker.acuity_promotion`, we promote the priority. This rewards high-acuity cases near a boundary while remaining predictable.

3. **Fallback scoring**
   - If ML features are missing or the dedup/scoring path flags a failure, we enable the configurable fallback (`triageFallback`):
     - Adds reason codes (e.g. `rule:fallback:delta_exceeded`, `rule:red_flag:chest_pain`).
     - Enforces the `scoreDeltaTolerance` to avoid silent drifts when recomputing with different inputs.
     - Imposes a `timeBudgetMs` to cap red-flag scanning and flags overruns with `rule:fallback:time_budget_hit`.
   - Red-flag matching uses the practice-specific `red_flag_set` and normalised tokens (no raw narrative stored).

4. **PHI minimisation**
   - Logs and metrics emit hashed references (`safePatientReference`, `safeTaskReference`) and reason codes only.
   - Events (`triage.decision`, `tasks.created`, `tasks.updated`) carry IDs, scores, priorities, and short reason codes—no narratives or clinician identifiers.

5. **Observability**
   - Metrics: `triage.score.decision`, `triage.score.clamped`, `triage.pipeline.duration_ms`.
   - Tests: `apps/triage/test/scoring.test.ts`, `apps/triage/test/performance.test.ts` enforce correctness and microbench limits.

## Consequences

- Scoring/priority configuration is fully driven by practice config, allowing safe experimentation without redeploys.
- Consumers of `triage.decision` can explain routing decisions by inspecting reason codes.
- The fallback path ensures even minimal submissions receive deterministic priorities, at the cost of coarser-grained reasons when ML data is absent.
- Calibrated thresholds must be updated in tandem with clinical guidance; incorrect configs can still degrade prioritisation, so CI should validate configs for monotonicity.
- The PHI-safe envelopes mean downstream services must fetch richer context from FHIR using the task ID if needed.
