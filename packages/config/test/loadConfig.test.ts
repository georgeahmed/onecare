import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/index';

function writeYaml(root: string, relativePath: string, contents: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents.trimStart(), 'utf8');
}

function setupLayeredConfigFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'config-fixture-'));

  writeYaml(root, 'nhs_gp_defaults.yaml', `
core_hours:
  start: "08:00"
  end: "17:00"
enhanced_access_windows:
  - "weekdays_evening"
  - "saturday"
red_flag_set:
  - "base-flag"
safety_gate:
  red_flag_threshold: 0.65
  emergency_confidence: 0.70
  acuity_threshold_emergency: 0.75
  timeout_ms: 800
  fallback: "rules"
idempotency:
  ttl_seconds: 600
`);

  writeYaml(root, 'global.yaml', `
__meta:
  arrayMerge:
    enhanced_access_windows: additive
    red_flag_set: additive
core_hours:
  end: "18:00"
enhanced_access_windows:
  - "global-window"
red_flag_set:
  - "global-flag"
`);

  writeYaml(root, 'ics/west.yaml', `
__meta:
  arrayMerge:
    enhanced_access_windows: additive
enhanced_access_windows:
  - "ics-window"
safety_gate:
  red_flag_threshold: 0.52
`);

  writeYaml(root, 'pcn/west-1.yaml', `
__meta:
  ics: "west"
enhanced_access_windows:
  - "pcn-window"
red_flag_set:
  - "pcn-flag"
safety_gate:
  emergency_confidence: 0.65
`);

  writeYaml(root, 'practices/pcn-west/practice-01.yaml', `
__meta:
  pcn: "west-1"
core_hours:
  start: "07:45"
enhanced_access_windows:
  - "practice-window"
red_flag_set:
  - "practice-flag"
safety_gate:
  timeout_ms: 100
  red_flag_threshold: 0.95
  emergency_confidence: 0.55
  acuity_threshold_emergency: 1.2
idempotency:
  ttl_seconds: 15
`);

  return root;
}

describe('loadConfig', () => {
  it('applies safety gate defaults and clamps overrides', () => {
    const cfg = loadConfig('demo-practice', {
      overrides: {
        safety_gate: {
          timeout_ms: 120,
          fallback: 'none',
          red_flag_threshold: 0.3,
          emergency_confidence: 1.5,
          acuity_threshold_emergency: 0.2,
        },
      },
    });

    expect(cfg.practiceId).toBe('demo-practice');
    expect(cfg.safety_gate?.timeout_ms).toBeGreaterThanOrEqual(400);
    expect(cfg.safety_gate?.timeout_ms).toBeLessThanOrEqual(2000);
    expect(cfg.safety_gate?.fallback).toBe('none');
    expect(cfg.safety_gate?.red_flag_threshold).toBeGreaterThanOrEqual(0.5);
    expect(cfg.safety_gate?.red_flag_threshold).toBeLessThanOrEqual(0.9);
    expect(cfg.safety_gate?.emergency_confidence).toBeGreaterThanOrEqual(0.6);
    expect(cfg.safety_gate?.emergency_confidence).toBeLessThanOrEqual(0.95);
    expect(cfg.safety_gate?.emergency_confidence).toBeGreaterThanOrEqual(cfg.safety_gate?.red_flag_threshold ?? 0);
    expect(cfg.safety_gate?.acuity_threshold_emergency).toBeGreaterThanOrEqual(cfg.safety_gate?.emergency_confidence ?? 0);
    expect(cfg.safety_gate?.fallback).toBe('none');
  });

  it('fills in defaults when overrides omit safety gate', () => {
    const cfg = loadConfig('demo-practice-2');
    expect(cfg.safety_gate?.timeout_ms).toBe(800);
    expect(cfg.safety_gate?.fallback).toBe('rules');
    expect(cfg.safety_gate?.red_flag_threshold).toBeGreaterThan(0);
    expect(cfg.safety_gate?.emergency_confidence).toBeGreaterThan(0);
    expect(cfg.safety_gate?.acuity_threshold_emergency).toBeGreaterThan(0);
    expect(cfg.idempotency?.ttlSeconds).toBe(900);
    const lineage = cfg._lineage as Record<string, unknown> | undefined;
    expect(Array.isArray(lineage?.sources)).toBe(true);
    expect((lineage?.sources as unknown[] | undefined)?.length).toBeGreaterThan(0);
  });

  it('merges layered YAML with additive arrays and lineage tracking', () => {
    const root = setupLayeredConfigFixture();
    try {
      const cfg = loadConfig('pcn-west/practice-01', { configRoot: root });

      expect(cfg.practiceId).toBe('pcn-west/practice-01');
      expect(cfg.core_hours?.start).toBe('07:45');
      expect(cfg.core_hours?.end).toBe('18:00');
      expect(cfg.enhanced_access_windows).toEqual([
        'weekdays_evening',
        'saturday',
        'global-window',
        'ics-window',
        'pcn-window',
        'practice-window',
      ]);
      expect(cfg.red_flag_set).toEqual([
        'base-flag',
        'global-flag',
        'pcn-flag',
        'practice-flag',
      ]);
      expect(cfg.idempotency?.ttlSeconds).toBe(30);
      expect(cfg.safety_gate?.timeout_ms).toBe(400);
      expect(cfg.safety_gate?.red_flag_threshold).toBe(0.9);
      expect(cfg.safety_gate?.emergency_confidence).toBe(0.9);
      expect(cfg.safety_gate?.acuity_threshold_emergency).toBeCloseTo(0.97, 5);

      const lineage = cfg._lineage as Record<string, unknown> | undefined;
      expect(lineage?.pcn).toBe('west-1');
      expect(lineage?.ics).toBe('west');
      expect(lineage?.sources).toEqual([
        'nhs_gp_defaults.yaml',
        'global.yaml',
        join('ics', 'west.yaml'),
        join('pcn', 'west-1.yaml'),
        join('practices', 'pcn-west', 'practice-01.yaml'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
