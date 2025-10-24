import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { CallTranscribed, IntentClassified } from './contracts';
import callTranscribedSchema from '../../../schemas/telephony/call-transcribed.json';
import intentClassifiedSchema from '../../../schemas/telephony/intent-classified.json';

export interface ContractValidationError {
  path: string;
  message: string;
  keyword: string;
}

export type ContractValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ContractValidationError[] };

const ajv = new Ajv({
  allErrors: true,
  meta: false,
});
const draft7Meta = require('ajv/dist/refs/json-schema-draft-07.json');
ajv.addMetaSchema(draft7Meta);

function formatErrors(errors: ErrorObject[] | null | undefined): ContractValidationError[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((error) => ({
    path: resolveErrorPath(error),
    message: error.message ?? error.keyword,
    keyword: error.keyword,
  }));
}

function resolveErrorPath(error: ErrorObject): string {
  const instancePath = (error as { instancePath?: string }).instancePath;
  if (typeof instancePath === 'string' && instancePath.length > 0) {
    return instancePath;
  }
  const dataPath = (error as { dataPath?: string }).dataPath;
  if (typeof dataPath === 'string' && dataPath.length > 0) {
    if (dataPath.startsWith('.')) {
      return `/${dataPath.slice(1)}`;
    }
    return dataPath;
  }
  return '/';
}

function makeValidator<T>(schema: Record<string, unknown>) {
  const validate = ajv.compile(schema) as ValidateFunction;
  return (payload: unknown): ContractValidationResult<T> => {
    if (validate(payload)) {
      return { ok: true, value: payload as T };
    }
    return { ok: false, errors: formatErrors(validate.errors) };
  };
}

export const validateCallTranscribed = makeValidator<CallTranscribed>(
  callTranscribedSchema as unknown as Record<string, unknown>,
);

export const validateIntentClassified = makeValidator<IntentClassified>(
  intentClassifiedSchema as unknown as Record<string, unknown>,
);
