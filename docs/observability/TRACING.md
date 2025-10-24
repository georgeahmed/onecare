# Trace Sampling Policy

The OpenTelemetry Collector now enforces a tail-based sampling policy that keeps the signals we care about while preventing runaway storage costs.

## Pipeline

- Receiver: OTLP (HTTP + gRPC) from all Node services.
- Processors:
  - `tail_sampling` waits up to 5 seconds for span completions and then applies the policies below.
  - `batch` forwards the retained traces downstream in consistent chunks.
- Exporter: `logging` for local visibility (swap for Tempo/Jaeger when deploying to shared infrastructure).

See `infra/otel/otel-collector.yaml` for the full configuration.

## Sampling Rules

Policy order matters—once a trace matches a rule, subsequent policies are skipped.

| Policy | Configuration | Result |
|--------|---------------|--------|
| `errors` | `status_code: ERROR` | Keep 100% of error traces. |
| `slow-traces` | `latency.threshold_ms: 1000` | Keep traces with a duration ≥1s so we can examine tail latency regressions. |
| `baseline-sampling` | `probabilistic.sampling_percentage: 20` | Sample 20% of the remaining traces to maintain representative coverage. |

Tweak thresholds via environment variables by mounting a generated config or by editing `tail_sampling` values in the collector config.

## Operational Guidance

- **Local dev**: the default thresholds strike a balance between noise and visibility. Reduce `expected_new_traces_per_sec` if you are testing with small traffic.
- **Staging/Prod**: replace the `logging` exporter with OTLP/Tempo. Add additional policies (e.g., route-specific sampling) as traffic grows.
- **Verification**: Generate load with `make stack-smoke` and inspect Grafana’s Explore view (Tempo) or the collector logs to confirm the sampling decisions match expectations.
