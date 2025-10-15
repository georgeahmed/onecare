import { Fragment, useMemo, useId } from 'react';
import { useIntl } from 'react-intl';
import type { TransformedAccessibilityConfig } from '../lib/config';

export interface InterpreterPreferencesProps {
  config: TransformedAccessibilityConfig;
  value: InterpreterPreferencesValue;
  onChange: (value: InterpreterPreferencesValue) => void;
  allowPersistence?: boolean;
}

export interface InterpreterPreferencesValue {
  requiresInterpreter: boolean;
  preferredLanguages?: string[];
  notes?: string;
  requiresInterpreterConfirmed?: boolean;
  rememberSelection?: boolean;
}

const InterpreterPreferences = ({ config, value, onChange, allowPersistence = false }: InterpreterPreferencesProps) => {
  const intl = useIntl();
  const sectionId = useId();
  const notesId = useId();
  const languageId = useId();
  const confirmId = useId();
  const rememberId = useId();
  const helpTextId = useId();

  if (!config || !config.interpreterLanguages || config.interpreterLanguages.length === 0) {
    return null;
  }

  const languages = useMemo(
    () => config.interpreterLanguages?.slice().sort((a, b) => a.localeCompare(b)) ?? [],
    [config.interpreterLanguages]
  );
  const requiresInterpreter = value.requiresInterpreter;
  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    onChange({
      requiresInterpreter: checked,
      preferredLanguages: checked ? value.preferredLanguages ?? [] : undefined,
      notes: checked ? value.notes : undefined,
      requiresInterpreterConfirmed: checked ? value.requiresInterpreterConfirmed : undefined,
      rememberSelection: checked ? value.rememberSelection : undefined
    });
  };

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const options = Array.from(event.target.selectedOptions ?? []);
    const selected = options.map((option) => option.value).filter((item) => languages.includes(item));
    onChange({ ...value, preferredLanguages: selected });
  };

  const handleNotesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...value, notes: event.target.value });
  };

  const handleConfirmChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...value, requiresInterpreterConfirmed: event.target.checked });
  };

  const handleRememberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...value, rememberSelection: event.target.checked });
  };

  const selectSize = Math.min(Math.max(languages.length, 3), 6);
  const selectedLanguages = value.preferredLanguages ?? [];

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
              multiple
              size={selectSize}
              value={selectedLanguages}
              onChange={handleLanguageChange}
              aria-describedby={helpTextId}
            >
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
            <p id={helpTextId} className="field-hint">
              {intl.formatMessage({ id: 'intake.interpreter.language.multipleHint' })}
            </p>
          </div>
          <div className="interpreter-field">
            <label htmlFor={notesId}>{intl.formatMessage({ id: 'intake.interpreter.notes.label' })}</label>
            <textarea
              id={notesId}
              value={value.notes ?? ''}
              onChange={handleNotesChange}
              rows={3}
              maxLength={300}
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
          {allowPersistence ? (
            <div className="interpreter-field interpreter-field--confirm">
              <input
                id={rememberId}
                type="checkbox"
                checked={Boolean(value.rememberSelection)}
                onChange={handleRememberChange}
              />
              <label htmlFor={rememberId}>{intl.formatMessage({ id: 'intake.interpreter.remember.label' })}</label>
              <p className="field-hint">{intl.formatMessage({ id: 'intake.interpreter.remember.hint' })}</p>
            </div>
          ) : null}
        </Fragment>
      ) : null}
    </section>
  );
};

export default InterpreterPreferences;
