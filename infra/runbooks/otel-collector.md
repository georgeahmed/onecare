OpenTelemetry Collector Runbook (Dev)

Purpose
- Provide a simple OTEL collector configuration for local/dev to receive traces/metrics/logs and export to stdout or OTLP.

Docker Compose service
```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector:0.97.0
    command: ["--config", "/etc/otel-config.yaml"]
    volumes:
      - ./infra/runbooks/otel-config.dev.yaml:/etc/otel-config.yaml:ro
    ports:
      - "4317:4317" # OTLP gRPC
      - "4318:4318" # OTLP HTTP
```

Collector config (stdout export)
```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:
processors:
  batch: {}
exporters:
  logging:
    logLevel: info
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [logging]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [logging]
```

Service config
- Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in services or use SDK defaults.
- Ensure correlationId is included as span attribute and in logs.

