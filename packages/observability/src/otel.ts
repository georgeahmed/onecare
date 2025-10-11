import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { context, diag, DiagConsoleLogger, DiagLogLevel, trace, type Span, type SpanOptions } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

type CorrelationContext = { correlationId?: string };

const tracerName = '@onecare/observability';
const correlationStorage = new AsyncLocalStorage<CorrelationContext>();
const correlationAttribute = 'onecare.correlation_id';

let fallbackCorrelationId: string | undefined;
let tracingEnabled = false;
let sdkInstance: NodeSDK | undefined;
let sdkInitPromise: Promise<void> | undefined;

const truthy = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']);
const falsy = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return undefined;
}

function shouldEnableTracing(): boolean {
  const explicit = parseBooleanFlag(process.env.OTEL_ENABLED);
  if (explicit !== undefined) return explicit;
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return true;
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return true;
  return false;
}

function ensureDiagLogger(): void {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

export function initTracing(serviceName: string): Promise<void> {
  if (sdkInitPromise) return sdkInitPromise;

  tracingEnabled = shouldEnableTracing();
  if (!tracingEnabled) {
    sdkInitPromise = Promise.resolve();
    return sdkInitPromise;
  }

  sdkInitPromise = Promise.resolve().then(() => {
    ensureDiagLogger();

    const baseResource = defaultResource();
    const serviceResource = resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE ?? 'onecare',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.HOSTNAME ?? randomUUID(),
    });
    const resource = baseResource.merge(serviceResource);

    try {
      const traceExporter = new OTLPTraceExporter();
      sdkInstance = new NodeSDK({ resource, traceExporter });
      sdkInstance.start();
      diag.info(`OpenTelemetry tracing initialized for ${serviceName}`);
    } catch (err) {
      tracingEnabled = false;
      console.error('Failed to start OpenTelemetry tracing', err);
    }
  });

  return sdkInitPromise;
}

export function startSpan(name: string, options?: SpanOptions): Span {
  const span = trace.getTracer(tracerName).startSpan(name, options);
  const cid = getCorrelationId();
  if (cid && span.isRecording()) {
    span.setAttribute(correlationAttribute, cid);
  }
  return span;
}

function normalizeCorrelationId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function updateCorrelationAttribute(id: string | undefined): void {
  if (!id) return;
  const span = trace.getSpan(context.active());
  if (!span || !span.isRecording()) return;
  span.setAttribute(correlationAttribute, id);
}

export function setCorrelationId(id: string | undefined) {
  const normalized = normalizeCorrelationId(id);
  const store = correlationStorage.getStore();
  if (store) {
    store.correlationId = normalized;
  } else {
    correlationStorage.enterWith({ correlationId: normalized });
  }
  fallbackCorrelationId = normalized;
  updateCorrelationAttribute(normalized);
}

export function getCorrelationId(): string | undefined {
  const store = correlationStorage.getStore();
  return store?.correlationId ?? fallbackCorrelationId;
}

export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

export type { Span };
