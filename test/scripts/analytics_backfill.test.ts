import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMetrics, getCounterTotal } from '@onecare/observability';
import { run as runBackfill, BackfillRunError } from '../../scripts/analytics_backfill.js';

function createMetricLine(metric: string, value: number, timestamp: string, labels: Record<string, string> = {}) {
  return JSON.stringify({
    name: metric,
    value,
    timestamp,
    labels,
  });
}

function readLedgerEntries(filePath: string) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  return content.map((line) => JSON.parse(line));
}

function readLineageEvents(filePath: string) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  return content.map((line) => JSON.parse(line));
}

describe('analytics_backfill run', () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    resetMetrics();
  });

  it('processes partitions and writes ledger entries', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-backfill-complete-'));
    const inputRoot = path.join(tempDir, 'input');
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    const ledgerPath = path.join(tempDir, 'ledger.jsonl');

    const dates = ['2025-01-01', '2025-01-02'];
    for (const date of dates) {
      const partitionDir = path.join(inputRoot, date);
      mkdirSync(partitionDir, { recursive: true });
      writeFileSync(
        path.join(partitionDir, 'metrics.jsonl'),
        [
          createMetricLine('requests_total', 1, `${date}T00:00:10.000Z`, { service: 'triage' }),
          createMetricLine('requests_total', 2, `${date}T00:01:10.000Z`, { service: 'triage' }),
        ].join('\n')
      );
    }

    const summary = await runBackfill([
      '--start',
      '2025-01-01',
      '--end',
      '2025-01-02',
      '--input-root',
      inputRoot,
      '--output',
      outputPath,
      '--ledger',
      ledgerPath,
      '--parallelism',
      '2',
    ]);

    expect(summary.status).toBe('completed');
    expect(summary.processedPartitions).toBe(2);
    expect(summary.skippedPartitions).toBe(0);
    expect(summary.failedPartitions).toBe(0);

    const rollupLines = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(rollupLines.length).toBeGreaterThan(0);
    expect(
      rollupLines.some((entry) => entry.windowSize === '1d' && entry.metric === 'requests_total')
    ).toBe(true);

    const ledgerEntries = readLedgerEntries(ledgerPath);
    expect(ledgerEntries.some((entry) => entry.type === 'job' && entry.event === 'start')).toBe(true);
    expect(ledgerEntries.some((entry) => entry.type === 'job' && entry.event === 'complete')).toBe(true);
    expect(
      ledgerEntries.filter(
        (entry) => entry.type === 'partition' && entry.status === 'success'
      ).length
    ).toBe(2);
    expect(ledgerEntries.find((entry) => entry.type === 'job' && entry.event === 'start')?.gitCommit).toBeTypeOf(
      'string'
    );

    const lineagePath = path.join(path.dirname(ledgerPath), 'lineage', 'analytics_backfill.jsonl');
    const lineageEvents = readLineageEvents(lineagePath);
    expect(lineageEvents.length).toBeGreaterThan(0);
    const completeEvent = lineageEvents.find((event) => event.eventType === 'COMPLETE');
    expect(completeEvent?.status).toBe('COMPLETED');

    expect(getCounterTotal('analytics.backfill.run')).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resumes successful partitions on retry', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-backfill-resume-'));
    const inputRoot = path.join(tempDir, 'input');
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    const ledgerPath = path.join(tempDir, 'ledger.jsonl');

    const firstPartitionDir = path.join(inputRoot, '2025-02-01');
    mkdirSync(firstPartitionDir, { recursive: true });
    writeFileSync(
      path.join(firstPartitionDir, 'metrics.jsonl'),
      [
        createMetricLine('errors_total', 1, '2025-02-01T02:15:00.000Z', { service: 'analytics' }),
        createMetricLine('errors_total', 1, '2025-02-01T02:17:00.000Z', { service: 'analytics' }),
      ].join('\n')
    );

    await expect(
      runBackfill([
        '--start',
        '2025-02-01',
        '--end',
        '2025-02-02',
        '--input-root',
        inputRoot,
        '--output',
        outputPath,
        '--ledger',
        ledgerPath,
        '--parallelism',
        '1',
      ])
    ).rejects.toBeInstanceOf(BackfillRunError);

    const secondPartitionDir = path.join(inputRoot, '2025-02-02');
    mkdirSync(secondPartitionDir, { recursive: true });
    writeFileSync(
      path.join(secondPartitionDir, 'metrics.jsonl'),
      [
        createMetricLine('errors_total', 2, '2025-02-02T00:05:00.000Z', { service: 'analytics' }),
        createMetricLine('errors_total', 3, '2025-02-02T00:10:00.000Z', { service: 'analytics' }),
      ].join('\n')
    );

    const resumeSummary = await runBackfill([
      '--start',
      '2025-02-01',
      '--end',
      '2025-02-02',
      '--input-root',
      inputRoot,
      '--output',
      outputPath,
      '--ledger',
      ledgerPath,
      '--parallelism',
      '1',
      '--resume',
    ]);

    expect(resumeSummary.status).toBe('completed');
    expect(resumeSummary.processedPartitions).toBe(1);
    expect(resumeSummary.failedPartitions).toBe(0);

    const ledgerEntries = readLedgerEntries(ledgerPath);
    const successDates = ledgerEntries
      .filter((entry) => entry.type === 'partition' && entry.status === 'success')
      .map((entry) => entry.partition?.date);
    expect(successDates).toContain('2025-02-01');
    expect(successDates).toContain('2025-02-02');

    const lineagePath = path.join(path.dirname(ledgerPath), 'lineage', 'analytics_backfill.jsonl');
    const lineageEvents = readLineageEvents(lineagePath);
    const failEvent = lineageEvents.find((event) => event.eventType === 'FAIL');
    expect(failEvent).toBeTruthy();
    const finalComplete = lineageEvents.filter((event) => event.eventType === 'COMPLETE').at(-1);
    expect(finalComplete?.status).toBe('COMPLETED');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('supports dry-run mode without writing outputs', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-backfill-dry-run-'));
    const inputRoot = path.join(tempDir, 'input');
    const outputPath = path.join(tempDir, 'rollup.jsonl');
    const ledgerPath = path.join(tempDir, 'ledger.jsonl');
    const date = '2025-03-01';

    const partitionDir = path.join(inputRoot, date);
    mkdirSync(partitionDir, { recursive: true });
    writeFileSync(
      path.join(partitionDir, 'metrics.jsonl'),
      [
        createMetricLine('requests_total', 5, `${date}T00:00:00.000Z`, { service: 'triage' }),
        createMetricLine('requests_total', 6, `${date}T00:05:00.000Z`, { service: 'triage' }),
      ].join('\n')
    );

    const summary = await runBackfill([
      '--date',
      date,
      '--input-root',
      inputRoot,
      '--output',
      outputPath,
      '--ledger',
      ledgerPath,
      '--dry-run',
    ]);

    expect(summary.status).toBe('completed');
    expect(summary.processedPartitions).toBe(1);
    expect(summary.failedPartitions).toBe(0);
    expect(existsSync(outputPath)).toBe(false);

    const ledgerEntries = readLedgerEntries(ledgerPath);
    const dryRunPartition = ledgerEntries.find(
      (entry) => entry.type === 'partition' && entry.status === 'dry-run'
    );
    expect(dryRunPartition?.partition?.date).toBe(date);

    const lineagePath = path.join(path.dirname(ledgerPath), 'lineage', 'analytics_backfill.jsonl');
    const lineageEvents = readLineageEvents(lineagePath);
    const completeEvent = lineageEvents.find((event) => event.eventType === 'COMPLETE');
    expect(completeEvent?.status).toBe('COMPLETED');
    expect(completeEvent?.result?.processedPartitions).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
