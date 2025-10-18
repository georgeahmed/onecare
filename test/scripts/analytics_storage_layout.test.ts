import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as storage from '../../scripts/analytics_storage_layout.js';

const SAMPLE_ROLLUPS = [
  {
    windowSize: '1m',
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-01T00:01:00.000Z',
    metric: 'latency_ms',
    labelHash: 'hash-latency-triage',
    labels: { service: 'triage', outcome: 'ok' },
    count: 2,
    numericCount: 2,
    p50: 120,
    p95: 180,
    generatedAt: '2025-01-01T00:01:10.000Z',
  },
  {
    windowSize: '1m',
    windowStart: '2025-01-01T00:01:00.000Z',
    windowEnd: '2025-01-01T00:02:00.000Z',
    metric: 'latency_ms',
    labelHash: 'hash-latency-triage',
    labels: { outcome: 'ok', service: 'triage' },
    count: 3,
    numericCount: 3,
    p50: 140,
    p95: 210,
    generatedAt: '2025-01-01T00:02:10.000Z',
  },
  {
    windowSize: '1m',
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-01T00:01:00.000Z',
    metric: 'errors_total',
    labelHash: 'hash-errors-triage',
    labels: { service: 'triage', outcome: 'error' },
    count: 1,
    numericCount: 1,
    p50: null,
    p95: null,
    generatedAt: '2025-01-01T00:01:30.000Z',
  },
];

describe('analytics_storage_layout', () => {
  let tempDir: string;
  let lakeRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-storage-test-'));
    lakeRoot = path.join(tempDir, 'lake');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes partitioned Parquet files and reads them back with pruning', async () => {
    const runId = 'test-run-write';
    const plans = storage.planPartitions(SAMPLE_ROLLUPS, { runId });
    expect(plans).toHaveLength(2);

    const writes = await storage.writePartitions(plans, lakeRoot, { runId });
    expect(writes).toHaveLength(2);

    const latencyOnly = await storage.readPartitions(lakeRoot, {
      metrics: ['latency_ms'],
    });
    expect(latencyOnly).toHaveLength(2);
    for (const record of latencyOnly) {
      expect(record.metric).toBe('latency_ms');
      expect(record.labels).toEqual({ outcome: 'ok', service: 'triage' });
      expect(record.writeRunId).toBe(runId);
      expect(record.schemaVersion).toBe(storage.SCHEMA_VERSION);
    }

    const latencyByDate = await storage.readPartitions(lakeRoot, {
      dates: ['2025-01-01'],
      metrics: ['latency_ms'],
      windows: ['1m'],
      labels: ['hash-latency-triage'],
    });
    expect(latencyByDate).toHaveLength(2);

    const errorsOnly = await storage.readPartitions(lakeRoot, {
      metrics: ['errors_total'],
    });
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]?.labels).toEqual({ outcome: 'error', service: 'triage' });
  });

  it('compacts multiple small files into a single Parquet file and records a manifest', async () => {
    const runA = 'test-run-a';
    const runB = 'test-run-b';
    const latencyRollups = SAMPLE_ROLLUPS.slice(0, 2);

    const planA = storage.planPartitions(latencyRollups, { runId: runA });
    await storage.writePartitions(planA, lakeRoot, { runId: runA });

    const planB = storage.planPartitions(latencyRollups, { runId: runB });
    await storage.writePartitions(planB, lakeRoot, { runId: runB });

    const beforeFiles = await storage.listPartitionFiles(lakeRoot);
    expect(beforeFiles.filter((file) => file.partition.metric === 'latency_ms')).toHaveLength(2);

    const manifests = await storage.compactPartitions(lakeRoot, {
      runId: 'compaction-run',
      targetBytes: 1024,
      minBytesToCompact: 1,
    });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.partition.metric).toBe('latency_ms');

    const afterFiles = await storage.listPartitionFiles(lakeRoot);
    const latencyFiles = afterFiles.filter((file) => file.partition.metric === 'latency_ms');
    expect(latencyFiles).toHaveLength(1);

    const compactedRecords = await storage.readPartitions(lakeRoot, {
      metrics: ['latency_ms'],
    });
    expect(compactedRecords).toHaveLength(4);

    const manifestPath = path.join(lakeRoot, 'compaction-manifest.jsonl');
    const manifestContent = readFileSync(manifestPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(manifestContent).toHaveLength(1);
    expect(manifestContent[0]?.runId).toBe('compaction-run');
    expect(manifestContent[0]?.outputFile.path).toContain('analytics-rollup-compaction-run.parquet');
  });
});
