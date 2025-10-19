## MLOps Cost & Performance Profiling

Use this guide to benchmark ML service resource usage, determine optimal scaling parameters, and inform capacity planning.

### Measurements

1. **CPU/GPU Utilization**
   - Capture `container_cpu_usage_seconds_total` / `container_memory_working_set_bytes`.
   - For GPU workloads, record `DCGM_FI_DEV_GPU_UTIL` and memory utilisation via DCGM.
   - Log results at steady-state (RPS 10) and peak (RPS 40) for 15 minutes each.
2. **Latency Percentiles**
   - Reuse `/metrics` histograms (`safety_gate_latency_ms_*`) and per-endpoint stats from the API gateway.
   - Track impact of canary deployments on latency, especially when shadow evaluation is enabled.
3. **Cold Start & Warmers**
   - Measure time from pod creation to `ready` (include image pull). Test with and without pre-warmed replicas (`minReplicas` / `minScale`).
4. **Autoscaling Behaviour**
   - Observe HPA status (`kubectl describe hpa safety-gate-hpa`) during a 10-minute ramp from RPS 5 → 35.
   - Record scale-out lag and residual latency to tune `averageValue` and `maxReplicas`.

### Recommended Settings (Initial)

| Environment | Replica Floor | HPA Target | MAX_INFLIGHT | Notes |
| --- | --- | --- | --- | --- |
| Staging | 2 | 15 RPS / 70% CPU | 30 | Enable shadowing + chaos tests |
| Production | 3 | 18 RPS / 65% CPU | 35 | Keep one warm spare pod per zone |
| GPU (vNext) | 1 | 12 RPS / 60% GPU | 20 | Use `emptyDir` tmpfs for model scratch |

Adjust values after each profiling session; document deviations in the changelog.

### Tooling

- Load generation: `scripts/perf/triage_flow.js` (HTTP) and `k6` scenarios for longer tests.
- Metrics export: `kubectl top pods`, Prometheus instant queries, or Grafana snapshots (export JSON for record).
- Cost estimation: combine utilization data with node pricing (see `infra/monitoring/cost/README.md`). Record GPU hourly rates for budgeting.

### Reporting Template

Include the following in each profiling report (link from the sprint doc):

- Date / build SHA
- Traffic profile (RPS, payload characteristics)
- Utilisation summary (CPU, memory, GPU)
- Latency p50/p95/p99 before & after optimisation
- Recommendation list (scale settings, code or infra changes)

Store reports in the shared ops drive and update this document when the baseline changes.
