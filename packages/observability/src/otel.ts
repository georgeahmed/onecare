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

let tracingEnabled = false;
let sdkInstance: NodeSDK | undefined;
let sdkInitPromise: Promise<void> | undefined;
const globalInitKey = Symbol.for('onecare.observability.initTracing');

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
  if (process.env.OTEL_EXPORTER_OTLP_HTTP_ENDPOINT) return true;
  return false;
}

function ensureDiagLogger(): void {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

export function initTracing(serviceName: string): Promise<void> {
  if (sdkInitPromise) return sdkInitPromise;
  const globalInit = (globalThis as Record<string | symbol, unknown>)[globalInitKey] as Promise<void> | undefined;
  if (globalInit) {
    sdkInitPromise = globalInit;
    return globalInit;
  }

  tracingEnabled = shouldEnableTracing();
  if (!tracingEnabled) {
    sdkInitPromise = Promise.resolve();
    (globalThis as Record<string | symbol, unknown>)[globalInitKey] = sdkInitPromise;
    return sdkInitPromise;
  }

  sdkInitPromise = (async () => {
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
      await sdkInstance.start();
      diag.info(`OpenTelemetry tracing initialized for ${serviceName}`);
    } catch (err) {
      tracingEnabled = false;
      sdkInstance = undefined;
      console.error('Failed to start OpenTelemetry tracing', err);
    }
  })();
  (globalThis as Record<string | symbol, unknown>)[globalInitKey] = sdkInitPromise;

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
    if (normalized) {
      store.correlationId = normalized;
    } else {
      delete store.correlationId;
    }
  } else {
    correlationStorage.enterWith(normalized ? { correlationId: normalized } : {});
  }
  updateCorrelationAttribute(normalized);
}

export function getCorrelationId(): string | undefined {
  const store = correlationStorage.getStore();
  return store?.correlationId;
}

export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

export function withCorrelationContext<T>(fn: () => T): T {
  const seed = correlationStorage.getStore();
  const initial = seed ? { ...seed } : {};
  return correlationStorage.run(initial, fn);
}

export type { Span };
