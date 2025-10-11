Task: SRE-01.8 — Kubernetes baseline (manifests/Helm: resources, probes, HPA, NetworkPolicies)

Context
- Provide k8s manifests or a Helm chart with resource requests/limits, liveness/readiness probes, HPAs, and NetworkPolicies for services.

Files
- infra/k8s/* or charts/onecare/* (new)
- docs/USAGE.md (k8s deploy notes)

Steps
1) Author Deployment/Service/ConfigMap manifests for orchestrator, triage, booking, pharmacy, and OTEL collector with resource requests/limits and probes.
2) Add HorizontalPodAutoscaler for CPU and optional custom metrics; configure min/max replicas.
3) Define NetworkPolicies to restrict egress (allowlist) and ingress between namespaces; block default public egress except allowlisted endpoints.
4) Provide values for TLS secrets and external endpoints; document apply steps.

Acceptance Criteria
- Baseline manifests compile; deploy to a local k8s (kind/minikube) succeeds; pods become Ready; policies applied.

Validate
- kubectl apply on kind; kubectl get pods; curl readiness endpoints.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.8' && make team-status-write

