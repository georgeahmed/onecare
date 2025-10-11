// Minimal OTEL-friendly API surface without importing external deps.

export interface Span {
  end(): void;
}

export function startSpan(_name: string): Span {
  return { end() {} };
}

let currentCorrelationId: string | undefined;

export function setCorrelationId(id: string | undefined) {
  currentCorrelationId = id || undefined;
}

export function getCorrelationId(): string | undefined {
  return currentCorrelationId;
}
