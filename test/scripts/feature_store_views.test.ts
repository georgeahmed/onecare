import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

import { parseArgs, upsertOnline } from '../../scripts/feature_store/views.js';

describe('feature_store/views CLI helpers', () => {
  it('parses online flags', () => {
    const args = parseArgs(['--input', 'input.jsonl', '--online', '--online-module', './custom.js', '--online-ttl', '120']);
    expect(args.input).toBe('input.jsonl');
    expect(args.online).toBe(true);
    expect(args.onlineModule).toBe('./custom.js');
    expect(args.onlineTtlSeconds).toBe(120);
  });

  it('upserts materialised records into the provided online store module', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'feature-view-store-'));
    const modulePath = path.join(tempDir, 'onlineStore.js');
    writeFileSync(
      modulePath,
      `class TestStore {\n  static records = [];\n  async upsert(record) { TestStore.records.push(record); }\n  async health() { return { status: 'ok', checkedAt: new Date().toISOString() }; }\n  async readiness() { return { ready: true, checkedAt: new Date().toISOString() }; }\n}\nmodule.exports = { InMemoryOnlineFeatureStore: TestStore };\nmodule.exports.__getRecords = () => TestStore.records;\n`
    );

    const recordsByView = {
      'triage-core.sliding-windows': [
        {
          featureSet: 'triage-core-windowed',
          entityId: 'patient-123',
          generatedAt: '2025-01-09T12:00:00.000Z',
          payload: { counts: { '1d': 2 } },
          metadata: { viewName: 'triage-core.sliding-windows', viewVersion: 'v1' },
        },
      ],
    };

    await upsertOnline(recordsByView, { moduleName: modulePath, ttlSeconds: 900 });

    const moduleUrl = pathToFileURL(modulePath);
    const loadedModule = await import(moduleUrl.href);
    const exported = (loadedModule.default ?? loadedModule) as { __getRecords: () => unknown[] };
    const stored = exported.__getRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      featureSet: 'triage-core-windowed',
      entityId: 'patient-123',
      ttlSeconds: 900,
    });

    rmSync(tempDir, { recursive: true, force: true });
  });
});
