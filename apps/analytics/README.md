Analytics Sink

Purpose
- Persist `analytics.metric` payloads to a durable JSONL file for downstream ingestion.

Environment
- `ANALYTICS_SINK_PATH`: Optional override for the sink path. Defaults to `var/analytics/metrics.jsonl` relative to the repo root.

Consumer
- `startAnalyticsConsumer()` subscribes to `Topics.analytics.metric`, validates payloads against the schema, and writes them to the configured sink.
