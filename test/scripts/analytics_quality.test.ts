import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetMetrics, getCounterTotal, getHistogramRecords } from '@onecare/observability';
import * as quality from '../../scripts/analytics_quality.js';

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetMetrics();
});

describe('analytics_quality instrumentation', () => {
  it('records metrics and emits outputs', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-quality-'));
    const inputPath = path.join(tempDir, 'metrics.jsonl');
    const outputPath = path.join(tempDir, 'quality.md');
    const quarantinePath = path.join(tempDir, 'quarantine.jsonl');

    writeFileSync(
      inputPath,
      [
        JSON.stringify({ name: 'requests_total', value: 1 }),
        JSON.stringify({ name: '', value: 2 }),
        JSON.stringify({ name: 'latency_ms', value: '250', timestamp: '2025-01-01T00:00:00.000Z' }),
      ].join('\n')
    );

    await quality.run(['--input', inputPath, '--output', outputPath, '--quarantine', quarantinePath, '--zscore', '2']);

    expect(getCounterTotal('analytics.quality.run')).toBe(1);
    expect(getCounterTotal('analytics.quality.records_processed')).toBe(3);
    expect(getCounterTotal('analytics.quality.missing_fields')).toBeGreaterThan(0);
    expect(getCounterTotal('analytics.quality.quarantine_records')).toBeGreaterThan(0);
    expect(getHistogramRecords('analytics.quality.duration_ms').length).toBe(1);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(quarantinePath)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
