import { describe, expect, it } from 'vitest';

import {
  getDefaultTtlSeconds,
  getFeatureRegistry,
  getFeatureSchemaId,
  getFeatureSet,
  isFeatureSetRegistered,
  listEntities,
  listFeatureSets,
  validateFeaturePayload,
} from '../src/features';

describe('Feature Registry helpers', () => {
  it('lists feature sets with metadata', () => {
    const featureSets = listFeatureSets();
    expect(featureSets.map((set) => set.name)).toContain('triage-core');
    expect(featureSets.map((set) => set.name)).toContain('acuity-signal');
  });

  it('returns clones so callers cannot mutate shared state', () => {
    const featureSets = listFeatureSets();
    featureSets[0]?.owners.push('intruder');

    const featureSetsAgain = listFeatureSets();
    expect(featureSetsAgain[0]?.owners).not.toContain('intruder');
  });

  it('exposes entity definitions', () => {
    const entities = listEntities();
    expect(entities.map((entity) => entity.name)).toContain('patient');
  });

  it('provides schema identifiers and TTL defaults', () => {
    expect(getFeatureSchemaId('triage-core')).toBe('https://onecare/schemas/features/triage-core.json');
    expect(getFeatureSchemaId('unknown')).toBeNull();
    expect(getDefaultTtlSeconds('acuity-signal')).toBe(600);
  });

  it('validates payloads using the schema registry', () => {
    const now = new Date().toISOString();
    const payload = {
      schemaVersion: 'v1.0.0',
      generatedAt: now,
      acuity: 0.82,
      risk: 0.54,
      complexity: 0.4,
      time: 0.61,
      capacity: 0.32,
      compositeScore: 0.57,
      source: 'unit-test',
    };
    const result = validateFeaturePayload('triage-core', payload);
    expect(result.ok).toBe(true);
  });

  it('flags unknown feature sets during validation', () => {
    const result = validateFeaturePayload('not-defined', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.keyword).toBe('unknownFeatureSet');
    }
  });

  it('returns immutable registry snapshot', () => {
    const registry = getFeatureRegistry();
    expect(isFeatureSetRegistered('triage-core')).toBe(true);
    registry.featureSets = [];
    expect(isFeatureSetRegistered('triage-core')).toBe(true);

    const featureSet = getFeatureSet('triage-core');
    expect(featureSet).not.toBeNull();
    if (featureSet) {
      featureSet.tags?.push('mutation');
      const again = getFeatureSet('triage-core');
      expect(again?.tags).not.toContain('mutation');
    }
  });
});
