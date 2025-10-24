# @onecare/observability

Shared telemetry helpers for logs, metrics, and OpenTelemetry tracing.

## Logging

- `logger.debug|info|warn|error` emit structured JSON with ISO timestamps and automatic `correlationId` injection.
- Payloads flow through the redaction engine so transcripts, IDs, secrets, and binary buffers become `"[REDACTED]"`. Circular structures are handled safely.
- `redact(value)` is exported for manual scrubbing ahead of audit payloads or DLQ snapshots.

```ts
import { logger } from '@onecare/observability';

logger.info('triage decision observed', { component: 'triage', priority, duplicate });
```

## Metrics

- `createCounter`, `createHistogram`, and `createGauge` provide lightweight in-process telemetry used by tests and local tooling.
- Metric values must be finite numbers; attributes are serialised to safe primitives and recorded immutably.
- `resetMetrics()` clears all stored state between test runs.

## Tracing

- `initTracing(serviceName)` boots the OTLP Node SDK when `OTEL_ENABLED=1` or OTLP endpoints are configured.
- `ensureTracing(serviceName)` guards multiple callers and retries if startup fails.
- `shutdownTracing()` flushes and tears down the SDK so tests or CLIs can exit cleanly.
- Async correlation helpers (`setCorrelationId`, `getCorrelationId`, `withCorrelationContext`, `startSpan`) keep spans, logs, and metrics aligned.

## DLQ Summaries

- `summariseForDlq(payload)` produces a redacted summary and SHA-1 digest for dead-letter queue publishing.

## Development

- Build: `npm -w @onecare/observability run build`
- Tests: `npx vitest run packages/observability/test`
