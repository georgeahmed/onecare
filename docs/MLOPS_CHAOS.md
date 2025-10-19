## MLOps Chaos & Resiliency Drills

Quarterly chaos drills validate that ML services remain within SLOs under common failure scenarios. Use the playbooks below for the Safety Gate service; replicate for other workloads as they adopt the same patterns.

### Prerequisites

- Staging environment with live traffic replay or synthetic load (`scripts/perf/triage_flow.js`).
- Alerting enabled (`infra/monitoring/ml_alerts.yml`) to observe breach conditions.
- Ability to drain nodes or apply `kubectl delete pod` without disrupting unrelated workloads (dedicated namespace).

### Scenarios

1. **Pod kill loop**
   - Command: `kubectl delete pod -l app=safety-gate --wait=false`
   - Expected behaviour: HPA/ReplicaSet recreates pods within 60s, error rate spike < 1%, p95 < 900 ms.
2. **Node drain**
   - Command: `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`
   - Verification: Pod reschedules on another node, readiness gate prevents traffic leakage, baseline resumes within 2 minutes.
3. **Network latency / packet loss**
   - Apply `tc` via chaos mesh or `kubectl exec` to introduce 200 ms latency and 10% loss towards downstream dependencies (e.g., feature store).
   - Expected result: `callWithGuard` retries trigger, circuit breaker avoids cascading failures, DLQ publishes for exhausted retries.

### Drill Execution Checklist

1. Announce maintenance window in #ml-ops with scenario, owner, and rollback plan.
2. Start synthetic load (target 50% of peak) to observe impact.
3. Execute chaos action; monitor dashboards:
   - `safety_gate_latency_ms_p95`
   - `safety_gate_red_flag_total`
   - HPA events (`kubectl get hpa safety-gate-hpa -w`)
4. Record recovery time, max error rate, and any alert firings.
5. Rollback chaos action (`kubectl uncordon`, remove `tc` rules, confirm pods stable).

### Reporting & Remediation

- Capture results in the runbook checklist with timestamps and screenshots (Grafana).
- File follow-up issues for missed SLOs or unexpected alerts; assign owners and deadlines.
- Update mitigation steps (e.g., increase max replicas, tweak circuit breaker thresholds) based on findings.

### Scheduling

- Run drills at least once per quarter.
- Alternate scenarios to cover pod kill, node drain, and network degradation over consecutive quarters.
- After major architecture changes (new rollout strategy, dependency, or autoscaling config), schedule an ad-hoc drill before production promotion.
