import type { FeatureRegistry } from '@onecare/events';
import type { ValidationError, ValidationResult } from '@onecare/domain';
import { validate as validateAgainstSchema } from '@onecare/domain';

import registryJson from '../../../schemas/features/registry.json';

type FeatureSetDefinition = FeatureRegistry['featureSets'][number];
type EntityDefinition = FeatureRegistry['entities'][number];

const clone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const registry = clone(registryJson) as unknown as FeatureRegistry;
const featureIndex = new Map<string, FeatureSetDefinition>();
const entityIndex = new Map<string, EntityDefinition>();

for (const featureSet of registry.featureSets) {
  featureIndex.set(featureSet.name, featureSet);
}

for (const entity of registry.entities) {
  entityIndex.set(entity.name, entity);
}

export function getFeatureRegistry(): FeatureRegistry {
  return clone(registry);
}

export function listFeatureSets(): FeatureSetDefinition[] {
  return clone(registry.featureSets);
}

export function listEntities(): EntityDefinition[] {
  return clone(registry.entities);
}

export function getFeatureSet(name: string): FeatureSetDefinition | null {
  const definition = featureIndex.get(name);
  return definition ? clone(definition) : null;
}

export function getEntityDefinition(name: string): EntityDefinition | null {
  const definition = entityIndex.get(name);
  return definition ? clone(definition) : null;
}

export function getFeatureSchemaId(featureSet: string): string | null {
  const definition = featureIndex.get(featureSet);
  return definition?.schemaId ?? null;
}

export function getDefaultTtlSeconds(featureSet: string): number | null {
  const definition = featureIndex.get(featureSet);
  return definition?.materialization.online?.ttlSeconds ?? null;
}

export function isFeatureSetRegistered(featureSet: string): boolean {
  return featureIndex.has(featureSet);
}

export function validateFeaturePayload(featureSet: string, payload: unknown): ValidationResult {
  const schemaId = getFeatureSchemaId(featureSet);
  if (!schemaId) {
    const error: ValidationError = {
      path: '',
      keyword: 'unknownFeatureSet',
      params: { featureSet },
      message: `Unknown feature set: ${featureSet}`,
      schemaPath: undefined,
    };
    return { ok: false, errors: [error] };
  }
  return validateAgainstSchema(schemaId, payload);
}
