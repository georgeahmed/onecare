import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import type { PortalSubmission } from '../../lib/types';
import defaultFieldConfig, { type FieldConfig, type FieldConfigMap, type FieldOption } from './fieldMap';

interface BaseJsonSchema {
  title?: string;
  description?: string;
}

export interface ObjectJsonSchema extends BaseJsonSchema {
  type: 'object';
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ArrayJsonSchema extends BaseJsonSchema {
  type: 'array';
  items?: JsonSchema;
}

export interface StringJsonSchema extends BaseJsonSchema {
  type: 'string';
  enum?: string[];
  format?: string;
}

export interface NumberJsonSchema extends BaseJsonSchema {
  type: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
}

export interface BooleanJsonSchema extends BaseJsonSchema {
  type: 'boolean';
}

export type JsonSchema =
  | ObjectJsonSchema
  | ArrayJsonSchema
  | StringJsonSchema
  | NumberJsonSchema
  | BooleanJsonSchema;

const isObjectSchema = (schema: JsonSchema): schema is ObjectJsonSchema => schema.type === 'object';

const isArraySchema = (schema: JsonSchema): schema is ArrayJsonSchema => schema.type === 'array';

const isStringSchema = (schema: JsonSchema): schema is StringJsonSchema => schema.type === 'string';

const isNumberSchema = (schema: JsonSchema): schema is NumberJsonSchema =>
  schema.type === 'number' || schema.type === 'integer';

const isBooleanSchema = (schema: JsonSchema): schema is BooleanJsonSchema => schema.type === 'boolean';

const hasEnumValues = (schema: StringJsonSchema): schema is StringJsonSchema & { enum: string[] } =>
  Array.isArray(schema.enum) && schema.enum.length > 0;

type PathSegment = string | number;

export type ValidationIssue =
  | { kind: 'required'; path: string }
  | { kind: 'enum'; path: string }
  | { kind: 'format-date'; path: string }
  | { kind: 'format-uri'; path: string }
  | { kind: 'type'; path: string; expected: string }
  | { kind: 'min-items'; path: string }
  | { kind: 'minimum'; path: string }
  | { kind: 'maximum'; path: string }
  | { kind: 'multiple-of'; path: string };

const toPathKey = (path: PathSegment[]): string => path.map((segment) => segment.toString()).join('.');

export const toFieldId = (key: string): string =>
  key ? `schema-field-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}` : 'schema-field-root';

const normalizeConfigKey = (key: string): string => key.replace(/\.\d+/g, '[]');

const resolveFieldConfig = (fieldConfig: FieldConfigMap, key: string): FieldConfig | undefined =>
  fieldConfig[key] ?? fieldConfig[normalizeConfigKey(key)];

const isEmptyString = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return value === '';
};

const isValidDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const isValidUrl = (value: string): boolean => {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const humanizeSegment = (segment: string): string =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const shallowEqualRecords = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
};

const getValueAtPath = (value: unknown, path: PathSegment[]): unknown =>
  path.reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      return Array.isArray(current) ? current[segment] : undefined;
    }
    if (typeof current === 'object') {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);

const setValueAtPath = <T,>(value: T, path: PathSegment[], next: unknown): T => {
  const apply = (current: unknown, index: number): unknown => {
    if (index >= path.length) {
      return next;
    }
    const segment = path[index];
    if (typeof segment === 'number') {
      const existing = Array.isArray(current) ? current.slice() : [];
      existing[segment] = apply(existing[segment], index + 1);
      return existing;
    }
    const currentRecord =
      current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    return {
      ...currentRecord,
      [segment]: apply(currentRecord[segment], index + 1)
    };
  };
  return apply(value, 0) as T;
};

const buildDefaultValue = (schema: JsonSchema | undefined): unknown => {
  if (!schema) return '';
  if (isObjectSchema(schema)) {
    const properties = schema.properties ?? {};
    return Object.keys(properties).reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = buildDefaultValue(properties[key]);
      return acc;
    }, {});
  }
  if (isArraySchema(schema)) {
    return [];
  }
  if (isStringSchema(schema)) {
    return '';
  }
  if (isNumberSchema(schema)) {
    return '';
  }
  if (isBooleanSchema(schema)) {
    return false;
  }
  return '';
};

const collectIssues = (schema: JsonSchema, value: unknown, path: PathSegment[], required: boolean): ValidationIssue[] => {
  const key = toPathKey(path);
  if (value === undefined || value === null) {
    if (required && key) {
      return [{ kind: 'required', path: key }];
    }
    return [];
  }

  if (isObjectSchema(schema)) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      if (required && key) {
        return [{ kind: 'type', path: key, expected: 'object' }];
      }
      return [];
    }
    const properties = schema.properties ?? {};
    const requiredProps = new Set(schema.required ?? []);
    return Object.entries(properties).flatMap(([prop, childSchema]) =>
      collectIssues(childSchema, (value as Record<string, unknown>)[prop], [...path, prop], requiredProps.has(prop))
    );
  }

  if (isArraySchema(schema)) {
    if (!Array.isArray(value)) {
      if (required && key) {
        return [{ kind: 'required', path: key }];
      }
      return [{ kind: 'type', path: key, expected: 'array' }];
    }
    const issues: ValidationIssue[] = [];
    if (required && value.length === 0 && key) {
      issues.push({ kind: 'min-items', path: key });
    }
    if (schema.items) {
      const itemSchema = schema.items;
      value.forEach((item, index) => {
        issues.push(...collectIssues(itemSchema, item, [...path, index], true));
      });
    }
    return issues;
  }

  if (isStringSchema(schema)) {
    if (isEmptyString(value)) {
      return required && key ? [{ kind: 'required', path: key }] : [];
    }
    if (typeof value !== 'string') {
      return key ? [{ kind: 'type', path: key, expected: 'string' }] : [];
    }
    if (schema.enum && !schema.enum.includes(value)) {
      return key ? [{ kind: 'enum', path: key }] : [];
    }
    if (schema.format === 'date' && !isValidDate(value)) {
      return key ? [{ kind: 'format-date', path: key }] : [];
    }
    if (schema.format === 'uri' && !isValidUrl(value)) {
      return key ? [{ kind: 'format-uri', path: key }] : [];
    }
  }

  if (isNumberSchema(schema)) {
    if (value === undefined || value === null || value === '') {
      return required && key ? [{ kind: 'required', path: key }] : [];
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return key ? [{ kind: 'type', path: key, expected: schema.type }] : [];
    }
    const issues: ValidationIssue[] = [];
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({ kind: 'minimum', path: key });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({ kind: 'maximum', path: key });
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const remainder = Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf));
      if (remainder > 1e-9) {
        issues.push({ kind: 'multiple-of', path: key });
      }
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      issues.push({ kind: 'type', path: key, expected: 'integer' });
    }
    return issues;
  }

  if (isBooleanSchema(schema)) {
    if (value === undefined || value === null) {
      return required && key ? [{ kind: 'required', path: key }] : [];
    }
    if (typeof value !== 'boolean') {
      return key ? [{ kind: 'type', path: key, expected: 'boolean' }] : [];
    }
    return [];
  }

  return [];
};

const buildErrorMap = (
  issues: ValidationIssue[],
  intl: ReturnType<typeof useIntl>,
  fieldConfig: FieldConfigMap
): Record<string, string> => {
  const errorEntries = issues.map<[string, string]>((issue) => {
    const formatMessage = (id: string) => intl.formatMessage({ id });
    const { path: issuePath } = issue;
    switch (issue.kind) {
      case 'required':
        return [issuePath, formatMessage('schemaForm.error.required')];
      case 'enum':
        return [issuePath, formatMessage('schemaForm.error.invalidOption')];
      case 'format-date':
        return [issuePath, formatMessage('schemaForm.error.invalidDate')];
      case 'format-uri':
        return [issuePath, formatMessage('schemaForm.error.invalidUrl')];
      case 'type':
        return [issuePath, formatMessage('schemaForm.error.invalidValue')];
      case 'min-items':
        return [issuePath, formatMessage('schemaForm.error.minItems')];
      case 'minimum':
        return [issuePath, formatMessage('schemaForm.error.minValue')];
      case 'maximum':
        return [issuePath, formatMessage('schemaForm.error.maxValue')];
      case 'multiple-of':
        return [issuePath, formatMessage('schemaForm.error.multipleOf')];
      default:
        return [issuePath, formatMessage('schemaForm.error.required')];
    }
  });
  return Object.fromEntries(errorEntries);
};

const remapTouchedAfterRemoval = (touched: Set<string>, arrayKey: string, removedIndex: number): Set<string> => {
  const next = new Set<string>();
  touched.forEach((key) => {
    if (!key.startsWith(`${arrayKey}.`)) {
      next.add(key);
      return;
    }
    const suffix = key.slice(arrayKey.length + 1);
    const [indexPart, ...rest] = suffix.split('.');
    const index = Number.parseInt(indexPart, 10);
    if (Number.isNaN(index)) {
      next.add(key);
      return;
    }
    if (index < removedIndex) {
      next.add(key);
      return;
    }
    if (index === removedIndex) {
      return;
    }
    const restPath = rest.join('.');
    const newKey = restPath ? `${arrayKey}.${index - 1}.${restPath}` : `${arrayKey}.${index - 1}`;
    next.add(newKey);
  });
  return next;
};

export const collectValidationIssues = (schema: JsonSchema, value: unknown): ValidationIssue[] =>
  collectIssues(schema, value, [], true);

export interface SchemaFormHandle {
  validateAll: () => boolean;
}

export interface SchemaFormProps<TValue> {
  schema: JsonSchema;
  value: TValue;
  onChange: (next: TValue) => void;
  fieldConfig?: FieldConfigMap;
  onErrorsChange?: (errors: Record<string, string>) => void;
}

const SchemaForm = forwardRef<SchemaFormHandle, SchemaFormProps<PortalSubmission>>(
  ({ schema, value, onChange, fieldConfig = defaultFieldConfig, onErrorsChange }, ref) => {
    const intl = useIntl();
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Set<string>>(() => new Set());

    const markTouched = (key: string) =>
      setTouched((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });

    const runValidation = useCallback(
      (candidate: PortalSubmission): Record<string, string> => {
        const issues = collectValidationIssues(schema, candidate);
        return buildErrorMap(issues, intl, fieldConfig);
      },
      [schema, intl, fieldConfig]
    );

    const syncErrors = useCallback(
      (nextErrors: Record<string, string>) => {
        let emitted = nextErrors;
        setErrors((prev) => {
          if (shallowEqualRecords(prev, nextErrors)) {
            emitted = prev;
            return prev;
          }
          return nextErrors;
        });
        if (onErrorsChange) {
          onErrorsChange(emitted);
        }
      },
      [onErrorsChange]
    );

    const updateValue = (path: PathSegment[], nextValue: unknown): PortalSubmission => {
      const candidate = setValueAtPath(value, path, nextValue);
      onChange(candidate);
      const nextErrors = runValidation(candidate);
      syncErrors(nextErrors);
      return candidate;
    };

    const focusFirstError = (errorMap: Record<string, string>) => {
      const [firstKey] = Object.keys(errorMap);
      if (!firstKey) return;
      const elementId = toFieldId(firstKey);
      if (typeof document !== 'undefined') {
        const element = document.getElementById(elementId);
        element?.focus?.();
      }
    };

    const validateAll = () => {
      const errorMap = runValidation(value);
      syncErrors(errorMap);
      const keys = Object.keys(errorMap);
      if (keys.length > 0) {
        setTouched(new Set(keys));
        focusFirstError(errorMap);
        return false;
      }
      return true;
    };

    useImperativeHandle(ref, () => ({
      validateAll
    }));

    useEffect(() => {
      if (onErrorsChange) {
        onErrorsChange({});
      }
    }, [onErrorsChange]);

    const renderObject = (
      currentSchema: ObjectJsonSchema,
      path: PathSegment[],
      isRoot: boolean
    ): JSX.Element | null => {
      const properties = currentSchema.properties ?? {};
      const entries = Object.entries(properties);
      if (entries.length === 0) return null;

      const content = entries.map(([key, childSchema]) =>
        renderSchema(childSchema, [...path, key], (currentSchema.required ?? []).includes(key))
      );

      if (isRoot) {
        return <>{content}</>;
      }

      const pathKey = toPathKey(path);
      const config = resolveFieldConfig(fieldConfig, pathKey);
      const legend =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;

      return (
        <fieldset key={pathKey}>
          <legend>{legend}</legend>
          {description ? <p>{description}</p> : null}
          {content}
        </fieldset>
      );
    };

    const renderEnumField = (
      currentSchema: StringJsonSchema & { enum: string[] },
      path: PathSegment[],
      required: boolean
    ): JSX.Element => {
      const pathKey = toPathKey(path);
      const config = resolveFieldConfig(fieldConfig, pathKey);
      const legend =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;
      const options: FieldOption[] =
        config?.options ?? currentSchema.enum.map((value: string) => ({ value, labelId: undefined }));
      const valueForField = getValueAtPath(value, path);
      const error = errors[pathKey];
      const showError = Boolean(error && touched.has(pathKey));
      const descriptionId = description ? `${toFieldId(pathKey)}-description` : undefined;
      const errorId = showError ? `${toFieldId(pathKey)}-error` : undefined;
      const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

      return (
        <fieldset key={pathKey} aria-describedby={describedBy}>
          <legend>
            {legend}
            {required ? (
              <span aria-hidden="true">
                {' '}
                *
              </span>
            ) : null}
          </legend>
          {description ? <p id={descriptionId}>{description}</p> : null}
          {options.map((option) => {
            const optionLabel =
              option.labelId !== undefined
                ? intl.formatMessage({ id: option.labelId })
                : humanizeSegment(option.value);
            const optionId = `${toFieldId(pathKey)}-${option.value}`;
            return (
              <div key={option.value}>
                <input
                  id={optionId}
                  type="radio"
                  name={pathKey}
                  value={option.value}
                  checked={valueForField === option.value}
                  onChange={() => {
                    markTouched(pathKey);
                    updateValue(path, option.value);
                  }}
                />
                <label htmlFor={optionId}>{optionLabel}</label>
              </div>
            );
          })}
          {showError ? (
            <p id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    };

    const renderArray = (currentSchema: ArrayJsonSchema, path: PathSegment[]): JSX.Element => {
      const pathKey = toPathKey(path);
      const arrayValue = getValueAtPath(value, path);
      const items = Array.isArray(arrayValue) ? arrayValue : [];
      const config = resolveFieldConfig(fieldConfig, pathKey);
      const legend =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;
      const error = errors[pathKey];
      const showError = Boolean(error && touched.has(pathKey));
      const descriptionId = description ? `${toFieldId(pathKey)}-description` : undefined;
      const errorId = showError ? `${toFieldId(pathKey)}-error` : undefined;
      const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

      const addLabel =
        (config?.addButtonId && intl.formatMessage({ id: config.addButtonId })) ??
        intl.formatMessage({ id: 'schemaForm.addItem' });
      const removeLabel =
        (config?.removeButtonId && intl.formatMessage({ id: config.removeButtonId })) ??
        intl.formatMessage({ id: 'schemaForm.removeItem' });

      const handleAdd = () => {
        const nextItems = Array.isArray(items) ? items.slice() : [];
        nextItems.push(buildDefaultValue(currentSchema.items));
        updateValue(path, nextItems);
      };

      const handleRemove = (index: number) => {
        if (!Array.isArray(items)) return;
        const nextItems = items.filter((_, idx) => idx !== index);
        const candidate = updateValue(path, nextItems);
        setTouched((prev) => remapTouchedAfterRemoval(prev, pathKey, index));
      };

      return (
        <fieldset key={pathKey} aria-describedby={describedBy}>
          <legend>{legend}</legend>
          {description ? <p id={descriptionId}>{description}</p> : null}
          {items.map((_, index) => {
            const itemSchema: JsonSchema = currentSchema.items ?? { type: 'string' };
            return (
              <div key={`${pathKey}.${index}`}>
                {renderSchema(itemSchema, [...path, index], true)}
                <button type="button" onClick={() => handleRemove(index)}>
                  {removeLabel}
                </button>
              </div>
            );
          })}
          <button type="button" onClick={handleAdd}>
            {addLabel}
          </button>
          {showError ? (
            <p id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    };

    const renderStringField = (
      currentSchema: StringJsonSchema,
      path: PathSegment[],
      required: boolean
    ): JSX.Element => {
      const pathKey = toPathKey(path);
      if (hasEnumValues(currentSchema)) {
        return renderEnumField(currentSchema, path, required);
      }

      const config = resolveFieldConfig(fieldConfig, pathKey);
      const label =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;
      const fieldId = toFieldId(pathKey);
      const descriptionId = description ? `${fieldId}-description` : undefined;
      const error = errors[pathKey];
      const showError = Boolean(error && touched.has(pathKey));
      const errorId = showError ? `${fieldId}-error` : undefined;
      const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
      const valueForField = getValueAtPath(value, path);
      const inputType =
        currentSchema.format === 'date'
          ? 'date'
          : currentSchema.format === 'uri'
          ? 'url'
          : 'text';

      const handleBlur = () => markTouched(pathKey);

      if (config?.widget === 'select') {
        const options: FieldOption[] =
          config.options ?? [];
        const normalizedValue = typeof valueForField === 'string' ? valueForField : '';
        return (
          <div key={pathKey}>
            <label htmlFor={fieldId}>
              {label}
              {required ? (
                <span aria-hidden="true">
                  {' '}
                  *
                </span>
              ) : null}
            </label>
            {description ? (
              <p id={descriptionId}>{description}</p>
            ) : null}
            <select
              id={fieldId}
              name={pathKey}
              value={normalizedValue}
              onChange={(event) => {
                markTouched(pathKey);
                updateValue(path, event.target.value);
              }}
              onBlur={handleBlur}
              aria-invalid={showError ? 'true' : undefined}
              aria-describedby={describedBy}
            >
              {!required ? (
                <option value="">
                  {' '}
                </option>
              ) : null}
              {options.map((option) => {
                const labelText =
                  option.labelId !== undefined
                    ? intl.formatMessage({ id: option.labelId })
                    : humanizeSegment(option.value);
                return (
                  <option key={option.value} value={option.value}>
                    {labelText}
                  </option>
                );
              })}
            </select>
            {showError ? (
              <p id={errorId} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      }

      if (config?.widget === 'textarea') {
        return (
          <div key={pathKey}>
            <label htmlFor={fieldId}>
              {label}
              {required ? (
                <span aria-hidden="true">
                  {' '}
                  *
                </span>
              ) : null}
            </label>
            {description ? (
              <p id={descriptionId}>{description}</p>
            ) : null}
            <textarea
              id={fieldId}
              name={pathKey}
              value={typeof valueForField === 'string' ? valueForField : ''}
              onChange={(event) => updateValue(path, event.target.value)}
              onBlur={handleBlur}
              aria-invalid={showError ? 'true' : undefined}
              aria-describedby={describedBy}
              rows={6}
            />
            {showError ? (
              <p id={errorId} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      }

      return (
        <div key={pathKey}>
          <label htmlFor={fieldId}>
            {label}
            {required ? (
              <span aria-hidden="true">
                {' '}
                *
              </span>
            ) : null}
          </label>
          {description ? (
            <p id={descriptionId}>{description}</p>
          ) : null}
          <input
            id={fieldId}
            name={pathKey}
            type={inputType}
            value={typeof valueForField === 'string' ? valueForField : ''}
            onChange={(event) => updateValue(path, event.target.value)}
            onBlur={handleBlur}
            aria-invalid={showError ? 'true' : undefined}
            aria-describedby={describedBy}
          />
          {showError ? (
            <p id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    };

    const renderNumberField = (
      currentSchema: NumberJsonSchema,
      path: PathSegment[],
      required: boolean
    ): JSX.Element => {
      const pathKey = toPathKey(path);
      const config = resolveFieldConfig(fieldConfig, pathKey);
      const label =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;
      const fieldId = toFieldId(pathKey);
      const descriptionId = description ? `${fieldId}-description` : undefined;
      const error = errors[pathKey];
      const showError = Boolean(error && touched.has(pathKey));
      const errorId = showError ? `${fieldId}-error` : undefined;
      const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
      const valueForField = getValueAtPath(value, path);
      const displayValue =
        typeof valueForField === 'number' && Number.isFinite(valueForField)
          ? String(valueForField)
          : typeof valueForField === 'string'
          ? valueForField
          : '';
      const step = currentSchema.type === 'integer' ? '1' : 'any';

      const handleBlur = () => markTouched(pathKey);

      return (
        <div key={pathKey}>
          <label htmlFor={fieldId}>
            {label}
            {required ? (
              <span aria-hidden="true">
                {' '}
                *
              </span>
            ) : null}
          </label>
          {description ? <p id={descriptionId}>{description}</p> : null}
          <input
            id={fieldId}
            name={pathKey}
            type="number"
            step={step}
            value={displayValue}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                updateValue(path, '');
                return;
              }
              const parsed = currentSchema.type === 'integer' ? Number.parseInt(raw, 10) : Number(raw);
              updateValue(path, Number.isNaN(parsed) ? raw : parsed);
            }}
            onBlur={handleBlur}
            aria-invalid={showError ? 'true' : undefined}
            aria-describedby={describedBy}
          />
          {showError ? (
            <p id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    };

    const renderBooleanField = (currentSchema: BooleanJsonSchema, path: PathSegment[]): JSX.Element => {
      const pathKey = toPathKey(path);
      const config = resolveFieldConfig(fieldConfig, pathKey);
      const label =
        (config?.labelId && intl.formatMessage({ id: config.labelId })) ??
        currentSchema.title ??
        humanizeSegment(path[path.length - 1]?.toString() ?? '');
      const description =
        (config?.descriptionId && intl.formatMessage({ id: config.descriptionId })) ?? currentSchema.description;
      const fieldId = toFieldId(pathKey);
      const descriptionId = description ? `${fieldId}-description` : undefined;
      const error = errors[pathKey];
      const showError = Boolean(error && touched.has(pathKey));
      const errorId = showError ? `${fieldId}-error` : undefined;
      const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
      const valueForField = getValueAtPath(value, path);

      const handleChange = (event: { target: { checked: boolean } }) => {
        updateValue(path, event.target.checked);
        markTouched(pathKey);
      };

      const handleBlur = () => markTouched(pathKey);

      return (
        <div key={pathKey}>
          <div>
            <input
              id={fieldId}
              name={pathKey}
              type="checkbox"
              checked={Boolean(valueForField)}
              onChange={handleChange}
              onBlur={handleBlur}
              aria-invalid={showError ? 'true' : undefined}
              aria-describedby={describedBy}
            />
            <label htmlFor={fieldId}>{label}</label>
          </div>
          {description ? <p id={descriptionId}>{description}</p> : null}
          {showError ? (
            <p id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    };

    const renderSchema = (currentSchema: JsonSchema, path: PathSegment[], required: boolean): JSX.Element | null => {
      if (isArraySchema(currentSchema)) {
        return renderArray(currentSchema, path);
      }
      if (isStringSchema(currentSchema)) {
        return renderStringField(currentSchema, path, required);
      }
      if (isNumberSchema(currentSchema)) {
        return renderNumberField(currentSchema, path, required);
      }
      if (isBooleanSchema(currentSchema)) {
        return renderBooleanField(currentSchema, path);
      }
      if (isObjectSchema(currentSchema)) {
        return renderObject(currentSchema, path, false);
      }
      return null;
    };

    const formContent = useMemo(() => {
      if (!isObjectSchema(schema)) return null;
      return renderObject(schema, [], true);
    }, [schema, value, errors, touched]);

    return <>{formContent}</>;
  }
);

SchemaForm.displayName = 'SchemaForm';

export default SchemaForm;
