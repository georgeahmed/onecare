/// <reference types="vitest/globals" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SchemaForm, { collectValidationIssues, type JsonSchema } from '../src/features/schemaForm/SchemaForm';
import type { PortalSubmission } from '../src/lib/types';
import { I18nProvider } from '../src/i18n';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../schemas/ingest/portal-submission.json';

const schema = portalSubmissionSchema as JsonSchema;

const buildSubmission = (overrides: Partial<PortalSubmission> = {}): PortalSubmission => ({
  practiceId: overrides.practiceId ?? '',
  patient: {
    id: overrides.patient?.id ?? '',
    dob: overrides.patient?.dob,
    locale: overrides.patient?.locale
  },
  channel: overrides.channel ?? 'web',
  narrative: overrides.narrative ?? '',
  attachments: overrides.attachments ?? []
});

describe('SchemaForm', () => {
  it('renders fields driven by JSON schema', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SchemaForm, {
          schema,
          value: buildSubmission(),
          onChange: () => undefined
        })
      )
    );

    expect(html).toContain('Practice ID');
    expect(html).toContain('Patient ID');
    expect(html).toContain('Narrative');
    expect(html).toContain('Attachments');
  });

  it('flags missing required fields', () => {
    const issues = collectValidationIssues(schema, buildSubmission());

    expect(issues.some((issue) => issue.path === 'practiceId' && issue.kind === 'required')).toBe(true);
    expect(issues.some((issue) => issue.path === 'patient.id' && issue.kind === 'required')).toBe(true);
    expect(issues.some((issue) => issue.path === 'narrative' && issue.kind === 'required')).toBe(true);
  });

  it('treats whitespace-only strings as empty', () => {
    const issues = collectValidationIssues(
      schema,
      buildSubmission({
        practiceId: '   ',
        patient: { id: '   ' },
        narrative: '   '
      })
    );

    expect(issues.some((issue) => issue.path === 'practiceId' && issue.kind === 'required')).toBe(true);
    expect(issues.some((issue) => issue.path === 'patient.id' && issue.kind === 'required')).toBe(true);
    expect(issues.some((issue) => issue.path === 'narrative' && issue.kind === 'required')).toBe(true);
  });

  it('enforces attachment field requirements', () => {
    const issues = collectValidationIssues(
      schema,
      buildSubmission({
        attachments: [{ contentType: '', url: '' }]
      })
    );

    expect(issues.some((issue) => issue.path === 'attachments.0.contentType' && issue.kind === 'required')).toBe(true);
    expect(issues.some((issue) => issue.path === 'attachments.0.url' && issue.kind === 'required')).toBe(true);
  });

  it('accepts a valid submission payload', () => {
    const issues = collectValidationIssues(
      schema,
      buildSubmission({
        practiceId: 'practice-123',
        patient: { id: 'patient-456', dob: '2024-01-01', locale: 'en' },
        narrative: 'Concern details go here.',
        attachments: [{ contentType: 'application/pdf', url: 'https://example.com/doc.pdf' }]
      })
    );

    expect(issues).toEqual([]);
  });

  it('validates numeric and boolean schema fields', () => {
    const extendedSchema: JsonSchema = {
      type: 'object',
      properties: {
        patientAge: { type: 'integer', minimum: 18 },
        consentGiven: { type: 'boolean' }
      },
      required: ['patientAge', 'consentGiven']
    };

    const issues = collectValidationIssues(extendedSchema, {
      patientAge: 15,
      consentGiven: 'yes'
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'patientAge', kind: 'minimum' }),
        expect.objectContaining({ path: 'consentGiven', kind: 'type' })
      ])
    );

    const validIssues = collectValidationIssues(extendedSchema, {
      patientAge: 21,
      consentGiven: true
    });

    expect(validIssues).toEqual([]);
  });
});
