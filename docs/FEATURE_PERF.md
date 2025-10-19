# Feature Store Performance Benchmarks

## Load Test Script

Use `scripts/bench/feature_store_load.js` to drive mixed read/write workloads against the online store (defaults to the in-memory implementation but can be pointed at Redis or Dynamo-backed stores by adjusting the import). Example:

```
node scripts/bench/feature_store_load.js \
  --duration 120 \
  --concurrency 32 \
  --entity-count 5000 \
  --write-ratio 0.25 \
  --payload-size medium \
  --ttl-seconds 3600
```

Output (JSON) contains total reads/writes, failure count, and latency percentiles. Persist the JSON artefact in `var/benchmarks/feature-store/` for longitudinal tracking.

## Targets (initial)

- p95 latency: ≤ 50 ms for GET, ≤ 80 ms for PUT under nominal load (32 concurrent).
- Cache hit ratio: ≥ 0.85 when TTL > 5 minutes.
- CPU utilisation on Redis < 60%; memory headroom ≥ 30%.

## Optimisations

- Adjust `MAX_INFLIGHT_REQUESTS` and HPA targets based on observed saturation.
- Tune Redis/Dynamo pipeline batch size and connection pool to reduce latency.
- Ensure local LRU cache is warmed during deploys to avoid thundering herds.

Record benchmark runs in the ops doc with date, build SHA, and parameter set. Use findings to update autoscaling settings (`docs/MLOPS_COST_PERF.md`).
