import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetMetrics, getCounterTotal, getHistogramRecords } from '@onecare/observability';
import * as exporter from '../../scripts/analytics_quarantine_export.js';

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  resetMetrics();
});

describe('analytics_quarantine_export instrumentation', () => {
  it('archives quarantine files and records metrics', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analytics-export-'));
    const inputPath = path.join(tempDir, 'quarantine.jsonl');
    const archiveRoot = path.join(tempDir, 'archive');

    writeFileSync(
      inputPath,
      [
        JSON.stringify({ reason: 'missing_name', record: { name: '', value: 1 } }),
        JSON.stringify({ reason: 'numeric_outlier', record: { name: 'latency', value: 9999 } }),
      ].join('\n')
    );

    await exporter.run(['--input', inputPath, '--archive', archiveRoot]);

    expect(getCounterTotal('analytics.quarantine_export.run')).toBe(1);
    expect(getCounterTotal('analytics.quarantine_export.files_archived')).toBe(1);
    expect(getHistogramRecords('analytics.quarantine_export.duration_ms').length).toBe(1);
    expect(readdirSync(archiveRoot).length).toBeGreaterThan(0);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
