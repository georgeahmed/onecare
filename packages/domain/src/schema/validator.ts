import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import metaDraft7 from 'ajv/dist/refs/json-schema-draft-07.json';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

type JSONSchema = { $id?: string } & Record<string, unknown>;

export interface ValidationError {
  path: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
  schemaPath?: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

type SchemaValidator = ValidateFunction<unknown>;

const validatorCache = new Map<string, SchemaValidator>();
const schemaCache = new Map<string, JSONSchema>();
const aliasToCanonical = new Map<string, string>();

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addMetaSchema(metaDraft7);
addFormats(ajv);

const fallbackSchemaRoot = path.resolve(__dirname, '../../../..', 'schemas');
const schemaRoot = process.env.ONECARE_SCHEMAS_DIR
  ? path.resolve(process.env.ONECARE_SCHEMAS_DIR)
  : fallbackSchemaRoot;

function normalizeSchemaId(schema: JSONSchema, providedId: string): string {
  if (typeof schema.$id === 'string' && schema.$id.length > 0) {
    return schema.$id;
  }
  return providedId;
}

function safeJoinSchemaPath(relative: string): string {
  const candidate = path.resolve(schemaRoot, relative);
  const rel = path.relative(schemaRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Schema path escapes schema root: ${relative}`);
  }
  return candidate;
}

function resolveSchemaPath(schemaId: string): string {
  if (path.isAbsolute(schemaId) && schemaId.endsWith('.json')) {
    return schemaId;
  }

  let relative: string;
  try {
    const url = new URL(schemaId);
    relative = url.pathname.replace(/^\/+/, '');
  } catch {
    relative = schemaId.replace(/^(?:\.\.\/)+/, '').replace(/^\.?\/*/, '');
  }

  if (relative.startsWith('schemas/')) {
    relative = relative.slice('schemas/'.length);
  }

  if (!relative.endsWith('.json')) {
    throw new Error(`Schema identifier must point to a JSON file: ${schemaId}`);
  }

  return safeJoinSchemaPath(relative);
}

function loadSchema(schemaId: string): { schema: JSONSchema; canonicalId: string } {
  const cachedId = aliasToCanonical.get(schemaId);
  if (cachedId) {
    const cachedSchema = schemaCache.get(cachedId);
    if (cachedSchema) {
      return { schema: cachedSchema, canonicalId: cachedId };
    }
  }

  const schemaPath = resolveSchemaPath(schemaId);
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as JSONSchema;
  const canonicalId = normalizeSchemaId(schema, schemaId);

  schemaCache.set(canonicalId, schema);
  aliasToCanonical.set(schemaId, canonicalId);
  aliasToCanonical.set(canonicalId, canonicalId);

  return { schema, canonicalId };
}

function ensureCompiledValidator(schemaId: string): SchemaValidator {
  const cachedId = aliasToCanonical.get(schemaId);
  if (cachedId) {
    const cachedValidator = validatorCache.get(cachedId);
    if (cachedValidator) {
      return cachedValidator;
    }
    const ajvValidator = ajv.getSchema(cachedId);
    if (ajvValidator) {
      validatorCache.set(cachedId, ajvValidator);
      return ajvValidator;
    }
  }

  const { schema, canonicalId } = loadSchema(schemaId);

  let validator = ajv.getSchema(canonicalId) as SchemaValidator | undefined;
  if (!validator) {
    ajv.addSchema(schema, canonicalId);
    validator = ajv.getSchema(canonicalId) as SchemaValidator | undefined;
  }
  if (!validator) {
    throw new Error(`Failed to compile schema validator for ${canonicalId}`);
  }

  validatorCache.set(canonicalId, validator);
  return validator;
}

function pointerForError(error: ErrorObject): string {
  const basePath = error.instancePath || '';

  if (error.keyword === 'required' && typeof (error.params as Record<string, unknown>).missingProperty === 'string') {
    const missing = (error.params as Record<string, unknown>).missingProperty as string;
    return `${basePath}/${missing}`.replace(/\/{2,}/g, '/') || `/${missing}`;
  }

  if (
    error.keyword === 'additionalProperties' &&
    typeof (error.params as Record<string, unknown>).additionalProperty === 'string'
  ) {
    const prop = (error.params as Record<string, unknown>).additionalProperty as string;
    return `${basePath}/${prop}`.replace(/\/{2,}/g, '/') || `/${prop}`;
  }

  return basePath || error.schemaPath || '';
}

function mapError(error: ErrorObject): ValidationError {
  const params = Object.assign({}, error.params as Record<string, unknown>);
  return {
    path: pointerForError(error),
    keyword: error.keyword,
    params,
    message: error.message ?? undefined,
    schemaPath: error.schemaPath,
  };
}

export function getValidator(schemaId: string): SchemaValidator {
  return ensureCompiledValidator(schemaId);
}

export function validate(schemaId: string, payload: unknown): ValidationResult {
  const validator = ensureCompiledValidator(schemaId);
  const valid = validator(payload);
  if (valid) {
    return { ok: true };
  }

  const errors = (validator.errors ?? [])
    .map((err) => mapError(err as ErrorObject))
    .sort((a: ValidationError, b: ValidationError) => {
      if (a.path === b.path) {
        return a.keyword.localeCompare(b.keyword);
      }
      return a.path.localeCompare(b.path);
    });
  return { ok: false, errors };
}

export function clearValidatorCache(): void {
  validatorCache.clear();
  schemaCache.clear();
  aliasToCanonical.clear();
  ajv.removeSchema();
}
