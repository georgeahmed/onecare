# MLOps Autoscaling & Concurrency Controls

Autoscaling keeps ML inference latency within the SLO envelope while controlling cost and saturation. This document covers Kubernetes HPA, optional Knative settings, and per-pod concurrency caps.

## Horizontal Pod Autoscaler (HPA)

- Baseline manifest: `infra/k8s/mlops/autoscaling/hpa-safety-gate.yaml`.
- Targets:
  - `requests_per_second` custom metric (from Prometheus Adapter) at 15 RPS per pod.
  - CPU utilisation at 70%.
  - Minimum replicas = 2 (no single point of failure), maximum = 10 (circuit breaker beyond that).
- Scale policies:
  - Scale up by at most 100% per minute.
  - Scale down slowly (50% per two minutes) to avoid thrashing traffic.
- Readiness probes gate pods before they receive traffic; the deployment exports `MAX_INFLIGHT_REQUESTS` and `REQUEST_TIMEOUT_MS` to shed load gracefully.

## Concurrency Guardrails

- The service honours `MAX_INFLIGHT_REQUESTS` (30) to cap outstanding work. When saturation hits the HTTP adapter should return 503 with a `Retry-After` header (see `qa/e2e/backpressure.spec.ts`).
- Use a small work queue per pod (<¼ of `MAX_INFLIGHT_REQUESTS`) to prevent backlog bursts.
- Log throttling as structured metrics (`throttle=true`) so HPA can receive auxiliary signals.

## Knative Optional Profile

- For bursty traffic, deploy a parallel Knative Service (example snippet):

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: safety-gate-knative
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/target: "40"
        autoscaling.knative.dev/window: "30s"
        autoscaling.knative.dev/scale-to-zero-grace-period: "5m"
    spec:
      containerConcurrency: 4
      timeoutSeconds: 5
      containers:
        - image: ghcr.io/onecare/safety-gate:1.12.0
          env:
            - name: REQUEST_TIMEOUT_MS
              value: "2000"
```

- Trade-offs:
  - **Cold starts**: expect 300–600 ms additional latency when scaling from zero. Mitigate by pinning `minScale=1` during business hours.
  - **Concurrency**: `containerConcurrency=4` keeps GPU batches stable; increase gradually if average latency stays below 200 ms.

## Validation Checklist

- [ ] Load test (e.g., `k6` script) at 2× projected peak for 15 minutes. Confirm p95 latency < 800 ms and error rate < 1%.
- [ ] Observe HPA events: `kubectl describe hpa safety-gate-hpa` shows target tracking. Capture scale-out/in times in the runbook.
- [ ] Verify saturation responses: when forced to 1 replica with RPS > 30, service returns 503/Retry-After in <2 s.
- [ ] Document final tuning numbers in `docs/MLOPS_SLOs.md`.
