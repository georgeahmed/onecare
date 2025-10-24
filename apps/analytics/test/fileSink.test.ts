import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Metric } from '@onecare/events';
import { createFileSink } from '../src/sink/fileSink';

describe('createFileSink', () => {
  it('recreates missing files and continues writing metrics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-sink-'));
    const filePath = join(dir, 'metrics.jsonl');
    const sink = createFileSink({ filePath });

    const firstMetric: Metric = { name: 'requests_total', value: 1 };
    await sink.write(firstMetric);

    await rm(filePath, { force: true });

    const secondMetric: Metric = { name: 'requests_total', value: 2 };
    await sink.write(secondMetric);

    const contents = await readFile(filePath, 'utf8');
    const parsed = contents
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Metric);

    expect(parsed).toEqual([secondMetric]);

    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
});
