import { supportedLocales } from '../../i18n';

export type FieldPathPattern = string;

export type FieldWidget = 'text' | 'textarea' | 'radio' | 'checkbox' | 'select';

export interface FieldOption {
  value: string;
  labelId?: string;
}

export interface FieldConfig {
  /**
   * Message id used to render the field label (or fieldset legend).
   */
  labelId?: string;
  /**
   * Message id used to render the field description/hint.
   */
  descriptionId?: string;
  /**
   * Preferred widget override for the field.
   */
  widget?: FieldWidget;
  /**
   * Message ids for enumerated options.
   */
  options?: FieldOption[];
  /**
   * Message id for the "add" button (array fields).
   */
  addButtonId?: string;
  /**
   * Message id for the "remove" button (array items).
   */
  removeButtonId?: string;
}

export type FieldConfigMap = Record<FieldPathPattern, FieldConfig>;

const localeOptions = supportedLocales.map((locale) => ({
  value: locale,
  labelId: `locale.name.${locale}`
}));

const defaultFieldConfig: FieldConfigMap = {
  practiceId: {
    labelId: 'intake.practiceId.label'
  },
  'patient.id': {
    labelId: 'intake.patientId.label'
  },
  'patient.dob': {
    labelId: 'intake.patient.dob.label'
  },
  'patient.locale': {
    labelId: 'intake.patient.locale.label',
    widget: 'select',
    options: localeOptions
  },
  channel: {
    labelId: 'intake.channel.legend',
    widget: 'radio',
    options: [
      { value: 'web', labelId: 'intake.channel.option.web' },
      { value: 'ivr', labelId: 'intake.channel.option.ivr' }
    ]
  },
  narrative: {
    labelId: 'intake.narrative.label',
    descriptionId: 'intake.narrative.hint',
    widget: 'textarea'
  },
  attachments: {
    labelId: 'intake.attachments.legend',
    descriptionId: 'intake.attachments.description',
    addButtonId: 'intake.attachments.add',
    removeButtonId: 'intake.attachments.remove'
  },
  'attachments[].contentType': {
    labelId: 'intake.attachment.contentType.label'
  },
  'attachments[].url': {
    labelId: 'intake.attachment.url.label'
  }
};

export default defaultFieldConfig;
