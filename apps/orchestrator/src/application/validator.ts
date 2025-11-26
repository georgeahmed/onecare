import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
// Import JSON Schemas directly (tsconfig resolves JSON modules)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../../schemas/ingest/portal-submission.json';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import guidedHelpSessionRequestSchema from '../../../../schemas/ingest/guided-help-session.request.json';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import guidedHelpSessionResponseSchema from '../../../../schemas/ingest/guided-help-session.response.json';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validatePortalSubmissionSchema = ajv.compile(portalSubmissionSchema);
const validateGuidedHelpSessionRequestSchema = ajv.compile(guidedHelpSessionRequestSchema);
const validateGuidedHelpSessionResponseSchema = ajv.compile(guidedHelpSessionResponseSchema);

export type ValidationError = { path: string; message: string };

export function validatePortalSubmission(
  obj: unknown
): { ok: true } | { ok: false; errors: ValidationError[] } {
  const ok = validatePortalSubmissionSchema(obj);
  if (ok) return { ok: true } as const;
  const errs: ValidationError[] =
    ((validatePortalSubmissionSchema.errors as ErrorObject[] | null | undefined) ?? []).map((e) => ({
      path: e.instancePath || e.schemaPath,
      message: e.message || 'invalid',
    }));
  return { ok: false, errors: errs } as const;
}

export function validateGuidedHelpSessionRequest(
  obj: unknown
): { ok: true } | { ok: false; errors: ValidationError[] } {
  const ok = validateGuidedHelpSessionRequestSchema(obj);
  if (ok) return { ok: true } as const;
  const errs: ValidationError[] =
    ((validateGuidedHelpSessionRequestSchema.errors as ErrorObject[] | null | undefined) ?? []).map((e) => ({
      path: e.instancePath || e.schemaPath,
      message: e.message || 'invalid',
    }));
  return { ok: false, errors: errs } as const;
}

export function validateGuidedHelpSessionResponse(
  obj: unknown
): { ok: true } | { ok: false; errors: ValidationError[] } {
  const ok = validateGuidedHelpSessionResponseSchema(obj);
  if (ok) return { ok: true } as const;
  const errs: ValidationError[] =
    ((validateGuidedHelpSessionResponseSchema.errors as ErrorObject[] | null | undefined) ?? []).map((e) => ({
      path: e.instancePath || e.schemaPath,
      message: e.message || 'invalid',
    }));
  return { ok: false, errors: errs } as const;
}
