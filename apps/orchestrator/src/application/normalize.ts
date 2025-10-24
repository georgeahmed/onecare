import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { PortalSubmission } from '@onecare/events';
import type { FhirBundle, FhirBundleEntry, InvalidFhirError } from '@onecare/ports';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundleSchema = require('../../../../schemas/fhir/bundle-transaction.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundleEntrySchema = require('../../../../schemas/fhir/bundle-entry-resource.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const communicationSchema = require('../../../../schemas/fhir/communication.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const documentReferenceSchema = require('../../../../schemas/fhir/document-reference.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const patientSchema = require('../../../../schemas/fhir/patient.json');

type BundleEntry = FhirBundleEntry & {
  fullUrl: string;
  request: {
    method: 'POST' | 'PUT';
    url: string;
  };
  resource: Record<string, unknown> & {
    resourceType: string;
  };
};

export function normalizeToFhir(submission: PortalSubmission): FhirBundle {
  const entries: BundleEntry[] = [];

  const patientId = submission.patient?.id;
  const createFullUrl = () => `urn:uuid:${randomUUID()}`;

  if (patientId) {
    entries.push({
      fullUrl: createFullUrl(),
      request: { method: 'PUT', url: `Patient/${patientId}` },
      resource: {
        resourceType: 'Patient',
        id: patientId,
      },
    });
  }

  const communicationEntry: BundleEntry = {
    fullUrl: createFullUrl(),
    request: { method: 'POST', url: 'Communication' },
    resource: {
      resourceType: 'Communication',
      status: 'completed',
      topic: submission.practiceId ? { text: submission.practiceId } : undefined,
      subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
      medium: submission.channel ? [{ text: submission.channel }] : undefined,
      ...(submission.narrative
        ? { payload: [{ contentString: submission.narrative }], note: [{ text: submission.narrative }] }
        : {}),
    },
  };
  entries.push(communicationEntry);

  if (Array.isArray(submission.attachments)) {
    submission.attachments
      .filter(
        (attachment) =>
          typeof attachment?.contentType === 'string' &&
          attachment.contentType.trim().length > 0 &&
          typeof attachment?.url === 'string' &&
          attachment.url.trim().length > 0
      )
      .forEach((attachment) => {
        entries.push({
          fullUrl: createFullUrl(),
          request: { method: 'POST', url: 'DocumentReference' },
          resource: {
            resourceType: 'DocumentReference',
            status: 'current',
            subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
            content: [
              {
                attachment: {
                  contentType: attachment.contentType,
                  url: attachment.url,
                },
              },
            ],
          },
        });
      });
  }

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: entries,
  };
}

const fhirValidator = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(bundleEntrySchema);
  ajv.addSchema(communicationSchema);
  ajv.addSchema(documentReferenceSchema);
  ajv.addSchema(patientSchema);
  return ajv.compile<FhirBundle>(bundleSchema);
})();

function coerceErrors(errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> | undefined {
  if (!errors || errors.length === 0) return undefined;
  return errors.slice(0, 5).map((err) => ({
    path: err.instancePath || err.schemaPath || '',
    message: err.message ?? 'invalid',
  }));
}

function createProfileError(resourceType: string, details?: Array<{ path: string; message: string }>): InvalidFhirError {
  const error = new Error('invalid_fhir') as InvalidFhirError & { details?: Array<{ path: string; message: string }> };
  error.name = 'InvalidFhirError';
  error.reason = 'profile_invalid';
  error.resourceType = resourceType;
  error.profile = (bundleSchema as { $id?: string }).$id ?? 'https://onecare/schemas/fhir/bundle-transaction.json';
  if (details) {
    error.details = details;
  }
  return error;
}

export async function validateProfiles(bundle: FhirBundle): Promise<void> {
  const valid = fhirValidator(bundle);
  if (!valid) {
    throw createProfileError('Bundle', coerceErrors(fhirValidator.errors));
  }
}
