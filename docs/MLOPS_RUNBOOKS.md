# MLOps Runbooks

Operational runbooks for the Safety Gate and related ML services. Keep these instructions up to date whenever rollout strategy or infrastructure changes. Link this page from team dashboards and on-call handbooks.

## Deploy & Promote

### Blue/Green Cutover

1. Apply the manifest:\
   `kubectl apply -f infra/k8s/mlops/rollouts/bluegreen.yaml`
2. Smoke-test the new colour (e.g. green):\
   `kubectl port-forward deploy/safety-gate-green 8081:8081`\
   `curl -H 'authorization: Bearer <key>' -H 'x-auth-scope: safety:analyze' -H 'x-consent-reference: Consent/test' http://127.0.0.1:8081/health`
3. Switch traffic by editing the service selector (`version: green`). The manifest already points to green; confirm with `kubectl get svc safety-gate-entry -o yaml`.
4. Monitor dashboards (`MLOps/Safety Gate`): latency, error rate, shadow agreement for 15 minutes.
5. Rollback: change selector back to the previous colour and scale the faulty deployment to zero. Record the incident in the ops log.

### Argo Canary Promotion

1. `kubectl apply -f infra/k8s/mlops/rollouts/argo-canary.yaml`
2. Follow rollout status:\
   `kubectl argo rollouts get rollout safety-gate-rollout`\
   `kubectl argo rollouts watch safety-gate-rollout`
3. The rollout pauses at each step; verify metrics (`p95 latency`, `error rate`, `shadow disagreement`). Resume with\
   `kubectl argo rollouts promote safety-gate-rollout`
4. Abort if alerts fire:\
   `kubectl argo rollouts abort safety-gate-rollout` then `kubectl argo rollouts promote safety-gate-rollout --to-stable`

### Shadow Trials

1. Enable Istio mirror: `kubectl apply -f infra/k8s/mlops/rollouts/shadow-mirror.yaml`.
2. Set environment variables: `SHADOW_SAMPLE_RATE`, `SHADOW_CANDIDATE_ENDPOINT`, `GOLDEN_SAMPLE_RATE/TOKEN`.
3. Observe `/metrics` & `/metrics/golden` on the candidate. Thresholds are defined in `docs/MLOPS_SHADOW.md`.
4. After the trial, disable mirroring (`kubectl delete virtualservice safety-gate-shadow`) and archive golden samples.

## Rollback & Incident Response

1. **Blue/Green**: revert service selector & scale down faulty colour.
2. **Canary**: `kubectl argo rollouts rollback safety-gate-rollout`.
3. **Shadow**: delete mirror manifest and disable candidate traffic.
4. Ensure DLQ velocity returns to baseline; investigate `features.ingest.dlq` for context.
5. Trigger post-incident review when SLO burn rate > 2× within a 6h window.

## Disaster Recovery

Scenario | Steps
--- | ---
Cluster loss | 1. Restore manifests from Git (latest `infra/k8s/mlops`). 2. Rekey secrets via Vault rotation runbook. 3. Deploy blue/green baseline and run smoke tests.
Image compromise | 1. Rebuild from source. 2. Re-sign with new cosign keys. 3. Verify signature in staging (`cosign verify --key env://COSIGN_PUBLIC_KEY`) before promotion.
Stateful dependency outage (Redis/feature store) | 1. Failover to standby endpoint (documented in `docs/FEATURE_ONLINE_STORE.md`). 2. Flush caches after failover. 3. Run health checks & confirm hit ratio recovers.

- Backups: object store snapshots (S3) daily; verify restore quarterly.
- Contacts: MLOps primary (PagerDuty schedule `MLOps-Primary`), secondary `Platform-Secondary`.
- Related docs: `docs/MLOPS_ROLLOUTS.md`, `docs/MLOPS_CHAOS.md`, `docs/MLOPS_SECURITY.md`.

## Incident Playbooks

Incident | Steps | Dashboards | Alerts
--- | --- | --- | ---
Feature drift spike | 1. Confirm `features.skw.*` breach in Grafana. 2. Check recent deployments and data pipeline changes. 3. Inspect PIT samples (`scripts/feature_store/pit_join_helper.js`) for anomalies. 4. Consider rolling back latest model or enabling shadow gate. | MLOps / Features → Drift | `FeatureSkewDetected`
Freshness breach | 1. Correlate `features.freshness.lag_ms` with ingestion retries/DLQ. 2. Check bus health and upstream publishers. 3. Reprocess backlog or trigger replay via `scripts/feature_store/ingest_stream.js`. | Freshness dashboard | `FeatureFreshnessBreach`, `FeatureIngestFailures`
Online store outage | 1. Verify readiness endpoint (`/ready`). 2. Failover to standby (runbook above). 3. Flush caches + rebuild if corruption suspected. 4. Monitor hit ratio and latency (`features.online.*`). | Online store health | Custom alerts (hit ratio, latency)

- Record RCA in incident tracker within 24h.
- Update runbooks if new remediation steps were required.
