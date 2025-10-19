import type { ObjectJsonSchema } from '../../features/schemaForm/SchemaForm';
import type { PortalSubmission } from '../../lib/types';

export type IntakeWizardStepId =
  | 'practice'
  | 'patient'
  | 'details'
  | 'attachments'
  | 'review';

export interface IntakeWizardStep {
  id: IntakeWizardStepId;
  titleId: string;
  descriptionId?: string;
  schema?: ObjectJsonSchema;
  optional?: boolean;
}

export interface IntakeWizardContext {
  accessibilityEnabled: boolean;
  includeAttachments: boolean;
}

export interface IntakeWizardMeta {
  includeAttachments: boolean;
}

export const DEFAULT_WIZARD_META: IntakeWizardMeta = {
  includeAttachments: false
};

const cloneSchema = (schema: ObjectJsonSchema): ObjectJsonSchema =>
  JSON.parse(JSON.stringify(schema)) as ObjectJsonSchema;

const pickProperties = (
  rootSchema: ObjectJsonSchema,
  propertyKeys: Array<keyof PortalSubmission>
): ObjectJsonSchema => {
  const subset: ObjectJsonSchema = {
    type: 'object',
    properties: {},
    required: []
  };

  propertyKeys.forEach((key) => {
    const properties = rootSchema.properties ?? {};
    if (!properties[key as string]) {
      return;
    }
    (subset.properties as Record<string, unknown>)[key as string] = cloneSchema(
      properties[key as string] as ObjectJsonSchema
    );
    if (Array.isArray(rootSchema.required) && rootSchema.required.includes(key as string)) {
      (subset.required as string[]).push(key as string);
    }
  });

  return subset;
};

export const createIntakeWizardSteps = (
  rootSchema: ObjectJsonSchema,
  context: IntakeWizardContext
): IntakeWizardStep[] => {
  const steps: IntakeWizardStep[] = [
    {
      id: 'practice',
      titleId: 'intake.wizard.practice.title',
      descriptionId: 'intake.wizard.practice.description',
      schema: pickProperties(rootSchema, ['practiceId', 'channel'])
    },
    {
      id: 'patient',
      titleId: 'intake.wizard.patient.title',
      descriptionId: context.accessibilityEnabled
        ? 'intake.wizard.patient.description.a11y'
        : 'intake.wizard.patient.description',
      schema: pickProperties(rootSchema, ['patient'])
    },
    {
      id: 'details',
      titleId: 'intake.wizard.details.title',
      descriptionId: 'intake.wizard.details.description',
      schema: pickProperties(rootSchema, ['narrative'])
    }
  ];

  if (context.includeAttachments) {
    steps.push({
      id: 'attachments',
      titleId: 'intake.wizard.attachments.title',
      descriptionId: 'intake.wizard.attachments.description',
      schema: pickProperties(rootSchema, ['attachments']),
      optional: true
    });
  }

  steps.push({
    id: 'review',
    titleId: 'intake.wizard.review.title',
    descriptionId: 'intake.wizard.review.description'
  });

  return steps;
};

export const findStepIndex = (
  steps: IntakeWizardStep[],
  stepId: IntakeWizardStepId
): number => steps.findIndex((step) => step.id === stepId);

export const getNextStepId = (
  steps: IntakeWizardStep[],
  currentStep: IntakeWizardStepId
): IntakeWizardStepId | null => {
  const currentIndex = findStepIndex(steps, currentStep);
  if (currentIndex === -1) {
    return null;
  }
  if (currentIndex + 1 >= steps.length) {
    return null;
  }
  return steps[currentIndex + 1].id;
};

export const getPreviousStepId = (
  steps: IntakeWizardStep[],
  currentStep: IntakeWizardStepId
): IntakeWizardStepId | null => {
  const currentIndex = findStepIndex(steps, currentStep);
  if (currentIndex <= 0) {
    return null;
  }
  return steps[currentIndex - 1].id;
};
