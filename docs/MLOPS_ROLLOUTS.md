# MLOps Rollout Strategies

This guide standardises how we deploy and validate new ML service builds across blue/green, canary, and shadow tracks. All approaches target the Safety Gate service, but the patterns are reusable for any ML workload that depends on fast rollback and safety analysis.

## Blue/Green Switchovers

- Deploy both colours in parallel (`safety-gate-green`, `safety-gate-blue`) and switch the `Service` selector. See `infra/k8s/mlops/rollouts/bluegreen.yaml`.
- Cutover steps:
  1. Deploy the new colour (`kubectl apply -f .../bluegreen.yaml`).
  2. Run smoke tests against the new colour (`kubectl port-forward deploy/safety-gate-green 8080:8080` + curl).
  3. Flip the `Service` selector from `version: blue` to `version: green` (already encoded in the manifest). This is an atomic switch.
  4. Monitor dashboards (latency, error rate) for 15 minutes. If issues surface, update the selector back to the previous colour and scale the faulty deployment down to zero.
- Rollback is a single `kubectl patch service` command, keeping the previous pods warm for instant recovery.

## Progressive Canary (Argo Rollouts)

- Argo Rollouts manages traffic weights with baked-in analysis. Reference manifest: `infra/k8s/mlops/rollouts/argo-canary.yaml`.
- Promotion path: 1% → 5% → 25% → 50% → 100%, pausing between steps to evaluate Prometheus queries.
- Automatic abort conditions:
  - p95 latency exceeds 800 ms for two consecutive intervals.
  - Error rate above 2% compared to the stable baseline.
- Operators can resume or abort with `kubectl argo rollouts promote safety-gate-rollout` or `kubectl argo rollouts abort safety-gate-rollout`.
- Rollouts expose both `stableService` and `canaryService`; the legacy `Ingress` points to the stable service so the platform only sees healthy traffic.
- CI enforces metric gates via `scripts/ci/check_canary_gates.sh` in `.github/workflows/cd.yml`; populate `CANARY_PSI`, `CANARY_JS`, `CANARY_FRESHNESS_MS`, and `CANARY_SHADOW_AGREEMENT` secrets or set `CANARY_OVERRIDE_REASON` with approval to bypass.

## Shadow Evaluation

- Mirror 5% of traffic to the candidate without impacting user responses, using Istio traffic mirroring (`infra/k8s/mlops/rollouts/shadow-mirror.yaml`).
- Shadow pods run the `vnext` label and write metrics via the Python harness (`services-py/safety_gate_service/shadow_eval.py`).
- During shadow trials capture:
  - Agreement rate versus production (target ≥ 98%).
  - Latency delta (target Δp95 < 120 ms).
  - Score drift (alert if |Δscore| ≥ 0.1).

## Runbooks

| Scenario | Command / Checklist |
| --- | --- |
| Promote blue→green | `kubectl apply -f infra/k8s/mlops/rollouts/bluegreen.yaml` → run smoke tests → monitor dashboards → announce completion |
| Abort canary | `kubectl argo rollouts abort safety-gate-rollout` → `kubectl argo rollouts promote --to-stable` |
| Start shadow trial | `kubectl apply -f infra/k8s/mlops/rollouts/shadow-mirror.yaml` → enable harness in app config (`SHADOW_SAMPLE_RATE=0.05`) → watch `shadowEvaluator.metrics()` endpoint/logs |
| Shadow analysis | Pull metrics snapshot (`/metrics/shadow`) → compare to thresholds in `docs/MLOPS_SHADOW.md` → file decision note |
| Rollback | For blue/green revert service selector; for canary run `kubectl argo rollouts rollback safety-gate-rollout` |

Keep the runbooks synchronised with `docs/RUNBOOKS.md`; link this page inside service READMEs when adopting the rollout pipeline.
