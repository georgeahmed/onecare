Task: SRE-01.16 — Kubernetes baseline (manifests/Helm: resources, probes, HPA, NetworkPolicies)

Context
- Establish production‑ready Kubernetes defaults: resource requests/limits, liveness/readiness/startup probes, HPA targets, NetworkPolicies, and ingress. Ensure parity with docker‑compose for dev.

Files
- infra/k8s/base/ (new)
- infra/k8s/helm/ (new or reference)
- apps/*/k8s/values.yaml (new)
- docs/RUNBOOKS.md (update with k8s notes)

Steps
1) Author base manifests or Helm charts covering: Deployments, Services, Ingress, ConfigMaps/Secrets, PodDisruptionBudget, HPA (CPU and optional custom metrics).
2) Define resource requests/limits per service; set probes with realistic thresholds (startup, readiness, liveness) matching app health endpoints.
3) Add NetworkPolicies: default‑deny; allow egress to broker/DB/egress allowlist; allow ingress only from Ingress/namespace‑scoped components.
4) Provide per‑service `values.yaml` examples for autoscaling and tunables (replicas min/max, target utilization, rollout strategies).
5) Document how to render/apply (kubectl/helm), and enumerate required secrets and config.

Acceptance Criteria
- All services have example manifests/values with requests/limits, probes, HPA, and NetworkPolicies.
- Documentation includes apply instructions and required secrets/config.

Validate
- helm template or kubectl kustomize renders successfully; run `kubectl apply --dry-run=client -f <rendered>`.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.16' && make team-status-write

