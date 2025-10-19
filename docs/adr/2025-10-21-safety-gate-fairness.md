# ADR: Safety Gate Bias & Fairness Audit

**Date:** 2025-10-21  
**Status:** Accepted

## Context
Safety Gate processes narratives across multiple channels (web, IVR) and languages (UK English, non-native English, transliterated Urdu). Earlier evaluation showed excellent aggregate accuracy but lacked subgroup visibility. We need:

- Repeatable slice metrics for key cohorts.
- Mitigations for any material gaps (recall shortfall >5%).
- Monitoring coverage so regressions surface before deploying.

## Decision
1. **Slice Definitions**
   - Language tags (`en-GB`, `en-nonnative`, `ur-translit`) are embedded per sample in the evaluation dataset.
   - Channel tags (`web`, `telephony`) are likewise recorded. Additional slices may be added for age or chronic condition cohorts when available.

2. **Evaluation Harness**
   - `services-py/safety_gate_service/eval/slices.py` computes per-slice confusion matrices and MetricSummary outputs (precision/recall/F1).
   - CI executes the evaluation script after unit tests and emits JSON artefacts for dashboards.

3. **Mitigations**
   - If recall on emergency/diverted class drops below 0.92 for any slice, the deployment is blocked.
   - For observed gaps on `en-nonnative`, the mitigations include: lexicon boost for respiratory terms and a lower red-flag threshold (+0.02 recall, <0.01 precision loss).
   - Telephony slices receive slightly higher batching thresholds to avoid latency-related timeouts.

4. **Monitoring**
   - New Prometheus metrics (`safety_gate_overload_total{reason=...}` and slice-level evaluation JSON) feed into Grafana panels.
   - On-call runbook references this ADR; remediation path emphasizes reverting model env knobs before exploring code changes.

## Consequences
- Evaluation data must include the `slice` column; missing metadata causes the harness to raise.
- Mitigations are codified in config and verified via regression tests.
- Future model promotions require re-running slice evaluations and updating this ADR when decisions change.
