import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig, getIcsOrganisationPolicies, getPharmacyEligibilityRules, type ResolvedConfig } from '../src/index';

function writeYaml(root: string, relativePath: string, contents: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents.trimStart(), 'utf8');
}

function setupLayeredConfigFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'config-fixture-'));

  const redFlagDir = join(root, 'red_flags');
  mkdirSync(redFlagDir, { recursive: true });
  writeFileSync(join(redFlagDir, 'core.json'), JSON.stringify(['core-flag']), 'utf8');

  writeYaml(root, 'nhs_gp_defaults.yaml', `
core_hours:
  start: "08:00"
  end: "17:00"
enhanced_access_windows:
  - "weekdays_evening"
  - "saturday"
red_flag_source: core
red_flag_set: []
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
access_gate:
  rate_limit:
    tenant:
      capacity: 80
      refill_per_second: 1.5
      ttl_seconds: 480
      max_entries: 1500
    account:
      capacity: 5
      refill_per_second: 0.2
      ttl_seconds: 300
      max_entries: 800
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
    expect(cfg.triageFallback?.enabled).toBe(true);
    expect(cfg.triageFallback?.timeBudgetMs).toBeGreaterThan(0);
    expect(cfg.triageFallback?.scoreDeltaTolerance).toBeGreaterThan(0);
    expect(cfg.triageFallback?.maxReasons).toBeGreaterThan(0);
    const lineage = cfg._lineage as Record<string, unknown> | undefined;
    expect(Array.isArray(lineage?.sources)).toBe(true);
    expect((lineage?.sources as unknown[] | undefined)?.length).toBeGreaterThan(0);
    expect(cfg.access_gate).toBeDefined();
    expect(cfg.access_gate?.rateLimit.tenant.capacity).toBe(120);
    expect(cfg.access_gate?.rateLimit.tenant.refillPerSecond).toBeCloseTo(2);
    expect(cfg.access_gate?.rateLimit.tenant.ttlSeconds).toBe(600);
    expect(cfg.access_gate?.rateLimit.tenant.maxEntries).toBe(2000);
    expect(cfg.access_gate?.rateLimit.account.capacity).toBe(12);
    expect(cfg.access_gate?.rateLimit.account.refillPerSecond).toBeCloseTo(0.3, 5);
    expect(cfg.access_gate?.rateLimit.account.ttlSeconds).toBe(600);
    expect(cfg.access_gate?.rateLimit.account.maxEntries).toBe(10000);
  });

  it('allows overriding triage fallback configuration', () => {
    const cfg = loadConfig('demo-fallback-override', {
      overrides: {
        triage: {
          fallback: {
            enabled: false,
            time_budget_ms: 45,
            score_delta_tolerance: 0.3,
            max_reasons: 3,
          },
        },
      } as Partial<ResolvedConfig>,
    });

    expect(cfg.triageFallback).toMatchObject({
      enabled: false,
      timeBudgetMs: 45,
      scoreDeltaTolerance: 0.3,
      maxReasons: 3,
    });
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
        'core-flag',
        'global-flag',
        'pcn-flag',
        'practice-flag',
      ]);
      expect(cfg.idempotency?.ttlSeconds).toBe(30);
      expect(cfg.safety_gate?.timeout_ms).toBe(400);
      expect(cfg.safety_gate?.red_flag_threshold).toBe(0.9);
      expect(cfg.safety_gate?.emergency_confidence).toBe(0.9);
      expect(cfg.safety_gate?.acuity_threshold_emergency).toBeCloseTo(0.97, 5);
      expect(cfg.access_gate).toBeDefined();
      expect(cfg.access_gate?.rateLimit.tenant.capacity).toBe(80);
      expect(cfg.access_gate?.rateLimit.tenant.refillPerSecond).toBeCloseTo(1.5);
      expect(cfg.access_gate?.rateLimit.tenant.ttlSeconds).toBe(480);
      expect(cfg.access_gate?.rateLimit.tenant.maxEntries).toBe(1500);
      expect(cfg.access_gate?.rateLimit.account.capacity).toBe(5);
      expect(cfg.access_gate?.rateLimit.account.refillPerSecond).toBeCloseTo(0.2);
      expect(cfg.access_gate?.rateLimit.account.ttlSeconds).toBe(300);
      expect(cfg.access_gate?.rateLimit.account.maxEntries).toBe(800);

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

  it('parses ICS route authRef and rateLimit aliases', () => {
    const overrides = {
      ics: {
        routes: {
          ORG1: {
            endpoint: 'https://ics.example/org1',
            authRef: 'secrets/ics/org1',
            rateLimit: 5,
          },
        },
      },
    } as unknown as Partial<ResolvedConfig>;

    const cfg = loadConfig('demo-ics', { overrides });
    const route = cfg.ics?.routes?.ORG1;
    expect(route?.authRef).toBe('secrets/ics/org1');
    expect(route?.rateLimitPerMinute).toBe(5);
  });

  it('builds ICS organisation policy mapping', () => {
    const config = {
      practiceId: 'demo',
      ics: {
        routes: {
          ORG1: {
            endpoint: 'https://ics.example/org1',
            authRef: 'secrets/ics/org1',
            rateLimitPerMinute: 12,
          },
          ORG2: {
            endpoint: 'https://ics.example/org2',
          },
        },
      },
    } as unknown as Parameters<typeof getIcsOrganisationPolicies>[0];

    const policies = getIcsOrganisationPolicies(config);
    expect(policies).toEqual({
      ORG1: {
        endpoint: 'https://ics.example/org1',
        authRef: 'secrets/ics/org1',
        rateLimit: 12,
      },
      ORG2: {
        endpoint: 'https://ics.example/org2',
      },
    });
  });

  it('normalises safety gate shadow configuration', () => {
    const cfg = loadConfig('shadow-demo', {
      overrides: {
        safety_gate: {
          shadow: {
            enabled: true,
            endpoint: ' https://shadow.example/safety ',
            sample_rate: 0.42,
            variant: 'next',
            timeout_ms: 420,
            max_retries: 1,
            base_delay_ms: 15,
            audit_event: 'custom.shadow.audit',
          },
        },
      },
    });

    expect(cfg.safety_gate?.shadow).toEqual({
      enabled: true,
      endpoint: 'https://shadow.example/safety',
      sampleRate: 0.42,
      variant: 'next',
      timeoutMs: 420,
      maxRetries: 1,
      baseDelayMs: 15,
      auditEvent: 'custom.shadow.audit',
    });
  });

  it('parses pharmacy eligibility rules with condition overrides', () => {
    const cfg = loadConfig('pharmacy-demo', {
      overrides: {
        pharmacy: {
          eligibility: {
            defaultRule: {
              minAge: 5,
              maxAge: 80,
              sex: ['female', 'male'],
              severity: { allowed: ['mild', 'Moderate'] },
              exclusions: ['pregnant'],
            },
            conditions: {
              UTI: {
                age: { min: 16 },
                sex: ['female'],
                exclusions: ['catheter'],
              },
            },
          },
        },
      } as Partial<ResolvedConfig>,
    });

    const eligibility = cfg.pharmacy?.eligibility;
    expect(eligibility?.defaultRule?.age?.min).toBe(5);
    expect(eligibility?.defaultRule?.age?.max).toBe(80);
    expect(eligibility?.defaultRule?.sex).toEqual(['female', 'male']);
    expect(eligibility?.defaultRule?.severity?.allowed).toEqual(['mild', 'moderate']);
    expect(eligibility?.defaultRule?.exclusions).toEqual(['pregnant']);
    const utiRule = eligibility?.conditions?.uti;
    expect(utiRule?.age?.min).toBe(16);
    expect(utiRule?.age?.max).toBe(80);
    expect(utiRule?.sex).toEqual(['female']);
    expect(utiRule?.exclusions).toEqual(['pregnant', 'catheter']);
  });

  it('clones pharmacy eligibility rules via accessor', () => {
    const config = {
      practiceId: 'demo',
      pharmacy: {
        eligibility: {
          defaultRule: {
            age: { min: 10 },
            sex: ['male'],
            exclusions: ['fever'],
          },
          conditions: {
            soreThroat: {
              sex: ['male', 'female'],
              severity: { blocked: ['severe'] },
            },
          },
        },
      },
    } as unknown as ResolvedConfig;

    const rules = getPharmacyEligibilityRules(config);
    expect(rules?.conditions?.soreThroat?.severity?.blocked).toEqual(['severe']);
    if (rules?.defaultRule?.age) {
      rules.defaultRule.age.min = 99;
    }
    rules?.conditions?.soreThroat?.sex?.push('unknown');
    expect(config.pharmacy?.eligibility?.defaultRule?.age?.min).toBe(10);
    expect(config.pharmacy?.eligibility?.conditions?.soreThroat?.sex).toEqual(['male', 'female']);
  });
});
