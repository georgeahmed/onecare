import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetMetrics, getCounterTotal, getHistogramRecords } from '@onecare/observability';
import * as rollup from '../../scripts/metrics_rollup.js';

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetMetrics();
});

function readLineageEvents(filePath: string) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('metrics_rollup aggregateMetrics', () => {
  it('produces sliding-window rollups with label hashes', () => {
    const metrics = [
      {
        name: 'latency_ms',
        value: 100,
        labels: { service: 'triage', result: 'ok' },
        timestamp: '2025-01-01T00:00:30.000Z',
      },
      {
        name: 'latency_ms',
        value: 200,
        labels: { result: 'ok', service: 'triage' },
        timestamp: '2025-01-01T00:01:10.000Z',
      },
      {
        name: 'errors_total',
        value: 1,
        labels: { service: 'triage', status: '500' },
        timestamp: '2025-01-01T00:01:40.000Z',
      },
    ];

    const windows = rollup.resolveWindows('1m,5m,1h,1d');
    const generatedAt = '2025-01-01T01:00:00.000Z';

    const result = rollup.aggregateMetrics(metrics, {
      windows,
      defaultDate: '2025-01-01',
      generatedAt,
    });

    const latencyOneMinuteBuckets = result.filter(
      (entry) => entry.windowSize === '1m' && entry.metric === 'latency_ms'
    );
    expect(latencyOneMinuteBuckets).toHaveLength(2);
    const firstBucket = latencyOneMinuteBuckets.find(
      (entry) => entry.windowStart === '2025-01-01T00:00:00.000Z'
    );
    expect(firstBucket?.count).toBe(1);
    expect(firstBucket?.p50).toBe(100);
    expect(firstBucket?.p95).toBe(100);

    const aggregatedLabelHashes = new Set(result.map((entry) => entry.labelHash));
    expect(aggregatedLabelHashes.size).toBeGreaterThan(0);

    const dailyBucket = result.find(
      (entry) => entry.windowSize === '1d' && entry.metric === 'latency_ms'
    );
    expect(dailyBucket?.count).toBe(2);
    expect(dailyBucket?.generatedAt).toBe(generatedAt);
  });
});

describe('metrics_rollup writeRollups', () => {
  it('upserts rollups idempotently by window key', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'metrics-rollup-'));
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    const windows = rollup.resolveWindows('1m');
    const metrics = [
      {
        name: 'requests_total',
        value: 1,
        labels: { service: 'booking' },
        timestamp: '2025-01-01T00:00:10.000Z',
      },
      {
        name: 'requests_total',
        value: 1,
        labels: { service: 'booking' },
        timestamp: '2025-01-01T00:00:20.000Z',
      },
    ];

    const rollups = rollup.aggregateMetrics(metrics, {
      windows,
      generatedAt: '2025-01-01T00:05:00.000Z',
    });

    await rollup.writeRollups(outputPath, rollups);
    const firstPass = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n');
    expect(firstPass).toHaveLength(1);

    await rollup.writeRollups(outputPath, rollups);
    const secondPass = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n');
    expect(secondPass).toHaveLength(1);

    const parsed = JSON.parse(secondPass[0]);
    expect(parsed.count).toBe(2);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('metrics_rollup run backfill', () => {
  it('processes directories in backfill mode', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'metrics-rollup-backfill-'));
    const inputDir = path.join(tempDir, 'backfill', '2025-01-01');
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    mkdirSync(inputDir, { recursive: true });

    writeFileSync(
      path.join(inputDir, 'metrics.jsonl'),
      [
        JSON.stringify({
          name: 'errors_total',
          value: 1,
          labels: { service: 'triage' },
          timestamp: '2025-01-01T02:15:00.000Z',
        }),
        JSON.stringify({
          name: 'errors_total',
          value: 0,
          labels: { service: 'triage' },
          timestamp: '2025-01-01T02:16:00.000Z',
        }),
      ].join('\n')
    );

    await rollup.run(['--input-dir', path.join(tempDir, 'backfill'), '--output', outputPath, '--windows', '1m,1d']);

    const lines = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    expect(lines.length).toBeGreaterThan(0);
   expect(lines.some((entry) => entry.windowSize === '1d')).toBe(true);
   expect(lines.some((entry) => entry.windowSize === '1m')).toBe(true);

    const lineagePath = path.join(path.dirname(outputPath), 'lineage', 'metrics_rollup.jsonl');
    const lineageEvents = readLineageEvents(lineagePath);
    const startEvent = lineageEvents.find((event) => event.eventType === 'START');
    expect(startEvent?.attributes?.mode).toBe('backfill');

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('metrics_rollup instrumentation', () => {
  it('records metrics for incremental runs', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'metrics-rollup-run-'));
    const inputPath = path.join(tempDir, 'metrics.jsonl');
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          name: 'requests_total',
          value: 1,
          labels: { service: 'triage' },
          timestamp: '2025-01-01T00:00:10.000Z',
        }),
        JSON.stringify({
          name: 'requests_total',
          value: 2,
          labels: { service: 'triage' },
          timestamp: '2025-01-01T00:00:40.000Z',
        }),
      ].join('\n')
    );

    await rollup.run(['--input', inputPath, '--output', outputPath, '--windows', '1m,1d']);

    expect(getCounterTotal('analytics.rollup.run')).toBe(1);
    expect(getCounterTotal('analytics.rollup.metrics_processed')).toBe(2);
    expect(getCounterTotal('analytics.rollup.windows_emitted')).toBeGreaterThan(0);
    expect(getHistogramRecords('analytics.rollup.duration_ms').length).toBe(1);

    const lineagePath = path.join(path.dirname(outputPath), 'lineage', 'metrics_rollup.jsonl');
    const lineageEvents = readLineageEvents(lineagePath);
    const completeEvent = lineageEvents.find((event) => event.eventType === 'COMPLETE');
    expect(completeEvent?.status).toBe('COMPLETED');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
