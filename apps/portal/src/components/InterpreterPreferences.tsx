import { Fragment, useId } from 'react';
import { useIntl } from 'react-intl';
import type { TransformedAccessibilityConfig } from '../lib/config';

export interface InterpreterPreferencesProps {
  config: TransformedAccessibilityConfig;
  value: InterpreterPreferencesValue;
  onChange: (value: InterpreterPreferencesValue) => void;
}

export interface InterpreterPreferencesValue {
  requiresInterpreter: boolean;
  preferredLanguage?: string;
  notes?: string;
  requiresInterpreterConfirmed?: boolean;
}

const InterpreterPreferences = ({ config, value, onChange }: InterpreterPreferencesProps) => {
  const intl = useIntl();
  const sectionId = useId();
  const notesId = useId();
  const languageId = useId();
  const confirmId = useId();

  if (!config || !config.interpreterLanguages || config.interpreterLanguages.length === 0) {
    return null;
  }

  const languages = config.interpreterLanguages;
  const requiresInterpreter = value.requiresInterpreter;
  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    onChange({
      requiresInterpreter: checked,
      preferredLanguage: checked ? value.preferredLanguage : undefined,
      notes: checked ? value.notes : undefined,
      requiresInterpreterConfirmed: checked ? value.requiresInterpreterConfirmed : undefined,
    });
  };

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...value, preferredLanguage: event.target.value });
  };

  const handleNotesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...value, notes: event.target.value });
  };

  const handleConfirmChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...value, requiresInterpreterConfirmed: event.target.checked });
  };

  return (
    <section
      className="interpreter-preferences"
      aria-labelledby={sectionId}
    >
      <header>
        <h2 id={sectionId}>{intl.formatMessage({ id: 'intake.interpreter.title' })}</h2>
        <p>{intl.formatMessage({ id: 'intake.interpreter.description' })}</p>
      </header>
      <div className="interpreter-field">
        <input
          id={`${sectionId}-toggle`}
          type="checkbox"
          checked={requiresInterpreter}
          onChange={handleToggle}
        />
        <label htmlFor={`${sectionId}-toggle`}>{intl.formatMessage({ id: 'intake.interpreter.checkbox' })}</label>
      </div>
      {requiresInterpreter ? (
        <Fragment>
          <div className="interpreter-field">
            <label htmlFor={languageId}>{intl.formatMessage({ id: 'intake.interpreter.language.label' })}</label>
            <select
              id={languageId}
              value={value.preferredLanguage ?? ''}
              onChange={handleLanguageChange}
            >
              <option value="">{intl.formatMessage({ id: 'intake.interpreter.language.placeholder' })}</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>
          <div className="interpreter-field">
            <label htmlFor={notesId}>{intl.formatMessage({ id: 'intake.interpreter.notes.label' })}</label>
            <textarea
              id={notesId}
              value={value.notes ?? ''}
              onChange={handleNotesChange}
              rows={3}
            />
            <p className="field-hint">{intl.formatMessage({ id: 'intake.interpreter.notes.hint' })}</p>
          </div>
          {config.offerBsl ? (
            <div className="interpreter-field interpreter-field--confirm">
              <input
                id={confirmId}
                type="checkbox"
                checked={Boolean(value.requiresInterpreterConfirmed)}
                onChange={handleConfirmChange}
              />
              <label htmlFor={confirmId}>{intl.formatMessage({ id: 'intake.interpreter.confirmBsl' })}</label>
            </div>
          ) : null}
        </Fragment>
      ) : null}
    </section>
  );
};

export default InterpreterPreferences;
