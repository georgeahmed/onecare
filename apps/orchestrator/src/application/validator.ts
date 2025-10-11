import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
// Import JSON Schema directly (tsconfig resolves JSON modules)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../../schemas/ingest/portal-submission.json';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(portalSubmissionSchema);

export function validatePortalSubmission(obj: unknown): { ok: true } | { ok: false; errors: { path: string; message: string }[] } {
  const ok = validate(obj);
  if (ok) return { ok: true } as const;
  const errs: { path: string; message: string }[] = (validate.errors as ErrorObject[] | null | undefined)?.map((e) => ({
    path: e.instancePath || e.schemaPath,
    message: e.message || 'invalid',
  })) || [];
  return { ok: false, errors: errs } as const;
}

