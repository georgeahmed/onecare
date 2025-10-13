# OpenTelemetry Collector (Dev)

This collector runs locally via docker-compose to fan in traces/metrics/logs emitted over OTLP from the orchestrator and Python services.

## Running locally

1. Ensure `docker compose` services are down.
2. Start the stack: `docker compose up -d otel-collector`.
3. Point services at the collector:
   - Node: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), and optionally `OTEL_ENABLED=1` to force-enable spans.
   - Python: set `OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
4. Generate traffic (e.g., POST to `/safety-check`). The collector logs show received spans/metrics.

## Configuration

The collector is configured via `infra/otel/otel-collector.yaml`:

- Receivers: OTLP gRPC (`4317`) and HTTP (`4318`).
- Processor: `batch` (flush every 5s or 512 spans).
- Exporter: `logging` (prints summaries to container logs).
- Extension: `health_check` on `:13133`.

## Overriding exporters

You can override exporters without editing the config by using environment variables when starting compose:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 \
OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=dev-key" \
docker compose up otel-collector
```

To plug in other exporters:

- **Tempo/Jaeger**: Add `otlp` exporter pointing at the backend, or enable built-in `jaeger` exporter.
- **Prometheus**: Add the `prometheusremotewrite` exporter and configure remote write endpoint.
- **Grafana Cloud/Lightstep/New Relic**: Set appropriate OTLP endpoint + headers via env overrides.

Update the YAML if you need custom pipelines; remember to reload the collector (`docker compose restart otel-collector`).

## Logs & Health

- Logs: `docker compose logs -f otel-collector` (shows summarized spans/metrics/logs).
- Health endpoint: `http://localhost:13133/healthz`.

## Next steps

- Add persistent exporters (Tempo, Prometheus, Loki) for richer observability.
- Wire services to propagate correlation IDs into OTEL spans.
- Extend dashboards/alerts once metrics flow into Grafana/Prometheus.
