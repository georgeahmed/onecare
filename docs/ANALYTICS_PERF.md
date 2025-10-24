# Analytics Performance Guide

This guide captures the tooling and operational playbook for validating the analytics pipeline under load.
It complements the observability dashboard work (DE-01.15) and the retention/backfill automation (DE-01.16/17).

## Load Generator (`scripts/bench/analytics_load_gen.js`)

Run the generator locally to publish synthetic `analytics.metric` envelopes into the in-process consumer and
measure ingest latency, sink throughput, and DLQ behaviour.

```bash
# Basic run: 5 minutes at 250 msgs/s writing to the default JSONL sink
node scripts/bench/analytics_load_gen.js --duration 300 --rate 250

# Custom sink/output and higher concurrency
node scripts/bench/analytics_load_gen.js \
  --duration 120 \
  --rate 500 \
  --concurrency 8 \
  --output /tmp/analytics-load.jsonl \
  --metrics latency_ms,requests_total,errors_total \
  --services triage,booking,telephony,orchestrator \
  --results ok,error,timeout
```

Key flags:

| Flag | Description | Default |
|------|-------------|---------|
| `--duration` | Test length in seconds | `60` |
| `--rate` | Target publish rate (envelopes per second) | `200` |
| `--concurrency` | Concurrent publishers (rate split evenly) | `4` |
| `--output` | JSONL sink path used by the consumer | `var/analytics/metrics.jsonl` |
| `--metrics` | Comma-separated metric names cycled during the run | `latency_ms,errors_total,requests_total` |
| `--services` | Label values for `service` (cycled per event) | `triage,booking,telephony,orchestrator` |
| `--results` | Label values for `result` | `ok,error,timeout` |
| `--min` / `--max` | Numeric value range for generated metrics | `0` / `500` |
| `--backpressure-ms` | Optional artificial delay (ms) injected before publishing to simulate downstream pressure | `0` |

**Output** — the script prints a JSON payload with:

- `sent`, `acknowledged`, `failures`, `dlqReasons`
- Achieved publish rate (`achievedRate`)
- Ingest latency percentiles (publish → sink write completion)
- Sink latency percentiles (file append duration)
- Ingest lag percentiles (wall-clock now vs. metric timestamp)

The generator runs entirely in-process, making it safe for CI and local tuning. To exercise the NATS-backed
deployment, point the analytics service at a test namespace, run the generator, and compare counters/histograms
(`analytics_ingest_*`, `analytics_sink_latency_ms`) to the script’s summary.

## Recommended Experiments

| Scenario | Goal | Settings |
|----------|------|----------|
| Baseline capacity | Confirm steady-state throughput and latency | `--duration 180 --rate 250 --concurrency 4` |
| Burst tolerance | Observe retry/DLQ behaviour during spikes | `--duration 120 --rate 750 --concurrency 12` |
| Backpressure | Verify retry backoff under degraded sink performance | `--duration 120 --rate 300 --backpressure-ms 25` |

Collect the script output together with Prometheus snapshots (lag histograms, retries/DLQ counters) and note:

- P99 ingest latency stays below 150 ms at 250 msg/s.
- Retries remain near zero; DLQ reasons should be absent unless deliberately injected.
- Sink latency increases when the filesystem is constrained; if `p95` exceeds 40 ms for extended periods, consider
  adjusting batch sizes or moving the sink onto faster storage.

## Cost & Resource Considerations

| Component | Observation | Recommendation |
|-----------|-------------|----------------|
| Analytics consumer | CPU usage grows roughly linearly with publish rate. | Keep container CPU requests ≥1 vCPU; scale horizontally if sustained rate >1 k msg/s. |
| JSONL sink | File append limits overall throughput. | Verify filesystem latency; move to local SSD or batched object store writes if p95 sink latency > 40 ms. |
| Backfill/rollups | Running load tests alongside rollup jobs increases contention. | Schedule load tests outside the rollup window or throttle with `--rate`. |

## Integrating With Observability

- Dashboard panels (`docs/ANALYTICS_DASHBOARDS.md`) surface `analytics_ingest_*` counters and `analytics_sink_latency_ms`.
- Compare generator summaries to dashboard percentiles to ensure instrumentation alignment.
- Create alerts when:
  - `analytics_ingest_lag_ms` p95 exceeds 5 seconds for >5 minutes.
  - `analytics_ingest_retry_total` or `analytics_ingest_dlq_total` grows continuously during steady load.

## Next Steps

- Automate weekly smoke loads (low-frequency run) to detect regressions.
- Feed the summary JSON into CI artifacts when running under automation (e.g., attach to the playback workflow).
- Extend the generator with configurable label distributions once we have historical distributions from production.
