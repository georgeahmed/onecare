export interface MetricRecord {
  value: number;
  attributes?: Record<string, unknown>;
}

class Histogram {
  public readonly records: MetricRecord[] = [];

  constructor(public readonly name: string) {}

  record(value: number, attributes?: Record<string, unknown>): void {
    this.records.push({ value, attributes });
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
    this.total += value;
    this.records.push({ value, attributes });
  }

  reset(): void {
    this.total = 0;
    this.records.length = 0;
  }
}

const histograms = new Map<string, Histogram>();
const counters = new Map<string, Counter>();

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

export function getHistogramRecords(name: string): MetricRecord[] {
  return histograms.get(name)?.records ?? [];
}

export function getCounterRecords(name: string): MetricRecord[] {
  return counters.get(name)?.records ?? [];
}

export function getCounterTotal(name: string): number {
  return counters.get(name)?.total ?? 0;
}

export function resetMetrics(): void {
  histograms.forEach((hist) => hist.reset());
  counters.forEach((counter) => counter.reset());
}

export type HistogramMetric = Histogram;
export type CounterMetric = Counter;
