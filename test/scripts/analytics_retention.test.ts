import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMetrics, getCounterTotal, getHistogramRecords } from '@onecare/observability';
import { run as runRetention } from '../../scripts/analytics_retention.js';

type Summary = Awaited<ReturnType<typeof runRetention>>;

function touchOld(filePath: string, baseIso: string, daysAgo: number) {
  const baseMs = Date.parse(baseIso);
  const pastMs = baseMs - daysAgo * 24 * 60 * 60 * 1000;
  const pastSeconds = pastMs / 1000;
  utimesSync(filePath, pastSeconds, pastSeconds);
}

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetMetrics();
});

describe('analytics_retention', () => {
  it('simulates retention actions in dry-run mode', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-retention-dry-'));
    const lakeRoot = path.join(tempDir, 'lake');
    const backfillRoot = path.join(tempDir, 'backfill');
    const lineageDir = path.join(tempDir, 'lineage');
    const ledgerPath = path.join(tempDir, 'backfill-ledger.jsonl');
    const tierDir = path.join(tempDir, 'cold');

    mkdirSync(path.join(lakeRoot, 'date=2024-12-01', 'metric=latency', 'window=1d', 'label=default'), {
      recursive: true,
    });
    writeFileSync(path.join(lakeRoot, 'date=2024-12-01', 'metric=latency', 'window=1d', 'label=default', 'part.parquet'), 'stub');
    mkdirSync(path.join(lakeRoot, 'date=2025-01-31', 'metric=latency', 'window=1d', 'label=default'), {
      recursive: true,
    });

    mkdirSync(path.join(backfillRoot, '2024-12-15'), { recursive: true });
    writeFileSync(path.join(backfillRoot, '2024-12-15', 'metrics.jsonl'), 'stub');
    mkdirSync(path.join(backfillRoot, '2025-01-31'), { recursive: true });

    mkdirSync(lineageDir, { recursive: true });
    const oldLineage = path.join(lineageDir, 'metrics_rollup.jsonl');
    writeFileSync(oldLineage, '{}\n');
    touchOld(oldLineage, '2025-02-01T00:00:00.000Z', 60);

    const ledgerEntries = [
      JSON.stringify({ type: 'job', event: 'start', timestamp: '2024-12-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'job', event: 'start', timestamp: '2025-01-25T00:00:00.000Z' }),
    ];
    writeFileSync(ledgerPath, `${ledgerEntries.join('\n')}\n`);

    const summary: Summary = await runRetention([
      '--lake-root',
      lakeRoot,
      '--backfill-root',
      backfillRoot,
      '--lineage-dir',
      lineageDir,
      '--ledger',
      ledgerPath,
      '--tier-dir',
      tierDir,
      '--ttl-lake-days',
      '30',
      '--ttl-raw-days',
      '30',
      '--ttl-lineage-days',
      '30',
      '--ttl-ledger-days',
      '30',
      '--now',
      '2025-02-01T00:00:00.000Z',
      '--dry-run',
    ]);

    expect(summary.dryRun).toBe(true);
    expect(summary.tiered).toBeGreaterThanOrEqual(2);
    expect(summary.deleted).toBeGreaterThanOrEqual(0);
    expect(summary.ledgerCompacted).toBe(1);
    expect(existsSync(path.join(lakeRoot, 'date=2024-12-01'))).toBe(true);
    expect(existsSync(path.join(backfillRoot, '2024-12-15'))).toBe(true);
    expect(existsSync(oldLineage)).toBe(true);

    expect(getCounterTotal('analytics.retention.run')).toBe(1);
    expect(getHistogramRecords('analytics.retention.duration_ms').length).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tiers, deletes, compacts, and vacuums old analytics artifacts', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-retention-live-'));
    const lakeRoot = path.join(tempDir, 'lake');
    const backfillRoot = path.join(tempDir, 'backfill');
    const lineageDir = path.join(tempDir, 'lineage');
    const ledgerPath = path.join(tempDir, 'backfill-ledger.jsonl');
    const tierDir = path.join(tempDir, 'cold');

    mkdirSync(path.join(lakeRoot, 'date=2024-11-30', 'metric=latency', 'window=1d', 'label=default'), {
      recursive: true,
    });
    writeFileSync(path.join(lakeRoot, 'date=2024-11-30', 'metric=latency', 'window=1d', 'label=default', 'part.parquet'), 'stub');
    mkdirSync(path.join(lakeRoot, 'date=2025-01-25', 'metric=latency', 'window=1d', 'label=default'), {
      recursive: true,
    });
    mkdirSync(path.join(lakeRoot, 'date=2025-01-25', 'metric=latency', 'window=1d', 'label=default', 'empty'), {
      recursive: true,
    });

    mkdirSync(path.join(backfillRoot, '2024-10-10'), { recursive: true });
    writeFileSync(path.join(backfillRoot, '2024-10-10', 'metrics.jsonl'), 'stub');
    mkdirSync(path.join(backfillRoot, '2025-01-20'), { recursive: true });

    mkdirSync(lineageDir, { recursive: true });
    const lineageOld = path.join(lineageDir, 'analytics_backfill.jsonl');
    writeFileSync(lineageOld, '{}\n');
    touchOld(lineageOld, '2025-02-01T00:00:00.000Z', 120);
    const lineageRecent = path.join(lineageDir, 'metrics_rollup.jsonl');
    writeFileSync(lineageRecent, '{}\n');

    const ledgerEntries = [
      JSON.stringify({ type: 'partition', event: 'complete', timestamp: '2024-10-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'partition', event: 'complete', timestamp: '2025-01-15T00:00:00.000Z' }),
    ];
    writeFileSync(ledgerPath, `${ledgerEntries.join('\n')}\n`);

    const summary: Summary = await runRetention([
      '--lake-root',
      lakeRoot,
      '--backfill-root',
      backfillRoot,
      '--lineage-dir',
      lineageDir,
      '--ledger',
      ledgerPath,
      '--tier-dir',
      tierDir,
      '--ttl-lake-days',
      '60',
      '--ttl-raw-days',
      '90',
      '--ttl-lineage-days',
      '90',
      '--ttl-ledger-days',
      '60',
      '--now',
      '2025-02-01T00:00:00.000Z',
      '--vacuum',
    ]);

    expect(summary.dryRun).toBe(false);
    expect(summary.tiered).toBeGreaterThanOrEqual(2);
    expect(summary.ledgerCompacted).toBe(1);
    expect(summary.vacuumed).toBeGreaterThanOrEqual(1);

    expect(existsSync(path.join(lakeRoot, 'date=2024-11-30'))).toBe(false);
    expect(existsSync(path.join(tierDir, 'lake', 'date=2024-11-30'))).toBe(true);
    expect(existsSync(path.join(backfillRoot, '2024-10-10'))).toBe(false);
    expect(existsSync(path.join(tierDir, 'backfill', '2024-10-10'))).toBe(true);
    expect(existsSync(path.join(tierDir, 'lineage', 'analytics_backfill.jsonl'))).toBe(true);
    expect(existsSync(lineageOld)).toBe(false);
    const ledgerLines = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n');
    expect(ledgerLines.length).toBe(1);
    expect(ledgerLines[0]).toContain('2025-01-15');

    expect(existsSync(path.join(lakeRoot, 'date=2025-01-25', 'metric=latency', 'window=1d', 'label=default', 'empty'))).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
