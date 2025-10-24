export type MetricAttributeValue = string | number | boolean;

export interface MetricRecord {
  readonly value: number;
  readonly attributes?: Readonly<Record<string, MetricAttributeValue>>;
}

function ensureFinite(value: number, metricName: string, operation: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${operation}(${metricName}) requires a finite number`);
  }
}

function sanitizeAttributes(
  metricName: string,
  attributes?: Record<string, unknown>,
): Readonly<Record<string, MetricAttributeValue>> | undefined {
  if (!attributes) return undefined;
  const result: Record<string, MetricAttributeValue> = {};
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      result[key] = raw;
      continue;
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        throw new TypeError(`Attribute "${key}" on metric "${metricName}" must be finite`);
      }
      result[key] = raw;
      continue;
    }
    if (raw instanceof Date) {
      result[key] = raw.toISOString();
      continue;
    }
    result[key] = String(raw);
  }
  if (Object.keys(result).length === 0) return undefined;
  return Object.freeze({ ...result });
}

function storeRecord(records: MetricRecord[], record: MetricRecord): void {
  records.push({
    value: record.value,
    attributes: record.attributes ? Object.freeze({ ...record.attributes }) : undefined,
  });
}

class Histogram {
  public readonly records: MetricRecord[] = [];

  constructor(public readonly name: string) {}

  record(value: number, attributes?: Record<string, unknown>): void {
    ensureFinite(value, this.name, 'record');
    const attrs = sanitizeAttributes(this.name, attributes);
    storeRecord(this.records, { value, attributes: attrs });
  }

  reset(): void {
    this.records.length = 0;
  }
}

class Counter {
  public total = 0;
  public readonly records: MetricRecord[] = [];

  constructor(public readonly name: string) {}

  add(value: number, attributes?: Record<string, unknown>): void {
    ensureFinite(value, this.name, 'add');
    this.total += value;
    const attrs = sanitizeAttributes(this.name, attributes);
    storeRecord(this.records, { value, attributes: attrs });
  }

  reset(): void {
    this.total = 0;
    this.records.length = 0;
  }
}

class Gauge {
  public value = 0;
  public readonly records: MetricRecord[] = [];

  constructor(public readonly name: string) {}

  set(value: number, attributes?: Record<string, unknown>): void {
    ensureFinite(value, this.name, 'set');
    this.value = value;
    const attrs = sanitizeAttributes(this.name, attributes);
    storeRecord(this.records, { value, attributes: attrs });
  }

  reset(): void {
    this.value = 0;
    this.records.length = 0;
  }
}

const histograms = new Map<string, Histogram>();
const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();

export function createHistogram(name: string): Histogram {
  if (!histograms.has(name)) {
    histograms.set(name, new Histogram(name));
  }
  return histograms.get(name)!;
}

export function createCounter(name: string): Counter {
  if (!counters.has(name)) {
    counters.set(name, new Counter(name));
  }
  return counters.get(name)!;
}

export function createGauge(name: string): Gauge {
  if (!gauges.has(name)) {
    gauges.set(name, new Gauge(name));
  }
  return gauges.get(name)!;
}

export function getHistogramRecords(name: string): MetricRecord[] {
  const records = histograms.get(name)?.records ?? [];
  return records.map((record) => ({
    value: record.value,
    attributes: record.attributes ? { ...record.attributes } : undefined,
  }));
}

export function getCounterRecords(name: string): MetricRecord[] {
  const records = counters.get(name)?.records ?? [];
  return records.map((record) => ({
    value: record.value,
    attributes: record.attributes ? { ...record.attributes } : undefined,
  }));
}

export function getCounterTotal(name: string): number {
  return counters.get(name)?.total ?? 0;
}

export function getGaugeRecords(name: string): MetricRecord[] {
  const records = gauges.get(name)?.records ?? [];
  return records.map((record) => ({
    value: record.value,
    attributes: record.attributes ? { ...record.attributes } : undefined,
  }));
}

export function getGaugeValue(name: string): number {
  return gauges.get(name)?.value ?? 0;
}

export function resetMetrics(): void {
  histograms.forEach((hist) => hist.reset());
  counters.forEach((counter) => counter.reset());
  gauges.forEach((gauge) => gauge.reset());
}

export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;
export type HistogramMetric = Histogram;
export type CounterMetric = Counter;
export type GaugeMetric = Gauge;
