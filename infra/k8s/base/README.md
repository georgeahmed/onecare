# Kubernetes Baseline

This directory documents how to render and apply the `onecare-service` Helm chart. Each service ships a values file under `apps/<service>/k8s/values.yaml` that captures probes, resources, env vars, ingress, and network policies.

## Render manifests locally

```bash
helm dependency update infra/k8s/helm/onecare-service
helm template orchestrator infra/k8s/helm/onecare-service \
  -f apps/orchestrator/k8s/values.yaml \
  --set image.tag=$(git rev-parse --short HEAD) \
  --namespace orchestrator > out/orchestrator.yaml
```

Validate with `kubectl apply --dry-run=client -f out/orchestrator.yaml` before running an actual deploy.

## Required Secrets & Config

| Service      | Secret(s) / ConfigMap(s) |
|--------------|---------------------------|
| Orchestrator | `orchestrator-secrets` (NATS_URL, tokens), optional feature flags ConfigMap |
| Booking      | `booking-secrets` (GP Connect credentials) |
| ICS Hub      | `ics-hub-config` (resolved routing policy, see `ics-hub-config-example.yaml`), `ics-hub-secrets` (credentials) |

Populate secrets via Vault Agent/Sealed Secrets as described in `docs/SECURITY.md`.

## Applying to environments

```
helm upgrade --install orchestrator infra/k8s/helm/onecare-service \
  --namespace $NAMESPACE \
  --values apps/orchestrator/k8s/values.yaml \
  --set image.tag=$IMAGE_TAG \
  --set image.repository=$IMAGE_REPOSITORY \
  --atomic
```

For production, ensure `--atomic` and `--history-max` are set, and pair the rollout with the CD workflow (`.github/workflows/cd.yml`).
