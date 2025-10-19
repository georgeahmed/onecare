# Shadow Evaluation Harness

Shadow trials compare production (`v1`) and candidate (`vnext`) models on real traffic without impacting user responses. Use the tooling in `services-py/safety_gate_service/shadow_eval.py` together with the Istio mirror manifest (`infra/k8s/mlops/rollouts/shadow-mirror.yaml`).

## Enabling Shadow Mode

1. Deploy mirror routing: `kubectl apply -f infra/k8s/mlops/rollouts/shadow-mirror.yaml`.
2. Configure the service:
   - `SHADOW_SAMPLE_RATE=0.05` (default 5% of requests).
   - Point `SHADOW_CANDIDATE_ENDPOINT` or injector to the vNext deployment.
3. Instantiate `ShadowEvaluator` in the FastAPI dependency graph and expose metrics via `/metrics/shadow`.

## Metrics Captured

`ShadowEvaluator.metrics()` returns:

```json
{
  "sampleCount": 320,
  "agreement": 0.9875,
  "latency": {
    "primaryP95": 420.1,
    "candidateP95": 438.0,
    "deltaMean": 12.4
  },
  "scoreDeltaMean": 0.008
}
```

- **Agreement**: fraction of requests where outcomes match. Minimum acceptance: 0.98.
- **Latency delta**: candidate - primary mean. Threshold: < 120 ms.
- **Score delta**: Only recorded when both responses carry a numeric score (e.g., `probEmergency`).

## Decision Gates

| Metric | Pass | Warn | Fail |
| --- | --- | --- | --- |
| Agreement | ≥ 0.985 | 0.97–0.985 | < 0.97 |
| Latency Δ (mean) | < 100 ms | 100–150 ms | > 150 ms |
| Score Δ (abs mean) | < 0.05 | 0.05–0.1 | > 0.1 |

- Warn band triggers manual review but does not block auto-promotion if all other metrics pass.
- Fail results force rollback and incident review.

## Analysis Workflow

1. Run trial for ≥ 10k samples (~1 hour with 5% mirror).
2. Export snapshot (`curl https://safety-gate.staging.onecare.cloud/metrics/shadow`).
3. Compare against gates; attach results to promotion request (`docs/MODEL_REGISTRY.md` workflow).
4. For disagreements, sample 20 cases via logs (correlation IDs only) and inspect anonymised payloads offline.

## Safety & Privacy

- Shadow harness never persists full payloads; only metrics and anonymised statistics are logged.
- Do not mirror POST bodies containing PHI to external services; ensure the candidate runs within the same cluster boundary.
- Disable mirror (`kubectl delete virtualservice safety-gate-shadow`) once the trial completes.
