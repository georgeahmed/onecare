# ADR: Safety Gate Threshold & Calibration Strategy

**Date:** 2025-10-21  
**Status:** Accepted

## Context
The Safety Gate classifier produces emergency probabilities. Previously we relied on heuristic thresholds without calibration. We now have an evaluation harness and must standardise how thresholds are derived and recorded.

## Decision
1. **Temperature Scaling**
   - Probability calibration uses temperature scaling across a grid (0.6 – 3.5). Implementation lives in `services-py/safety_gate_service/eval/calibration.py`.
   - The chosen temperature minimises expected calibration error (ECE) on the held-out validation set; the baseline vs calibrated ECE is reported in CI artefacts.

2. **Threshold Selection**
   - PR curves are generated from calibrated outputs using `compute_pr_curve`. Thresholds are selected to achieve recall ≥0.95 with precision ≥0.6 for emergency detection.
   - The resulting thresholds are written to `config/safety_gate.yaml` alongside model/temperature hashes.

3. **Reproducibility**
   - Evaluation runs persist metrics as JSON in the build artefacts; the golden set includes the most recent model outputs for quick smoke tests.
   - When promoting a new model, the playbook is: (a) run calibration; (b) update config; (c) refresh golden set and manifest; (d) attach metrics to the PR.

4. **Runtime Enforcement**
   - `/ready` responds with the applied classifier version and warmup metadata so operators confirm the correct threshold set is active.
   - The batch processor and concurrency limiter use env-driven knobs to maintain the calibrated latency envelope.

## Consequences
- Promotions cannot bypass calibration; the pipeline fails if ECE gets worse than baseline.
- Developers must re-run the evaluation harness after changing model weights or lexicon rules.
- Documentation in this ADR must be updated with new thresholds, temperature, and evaluation results after each release.
