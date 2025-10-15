/// <reference types="vitest/globals" />

import { renderToStaticMarkup } from 'react-dom/server';
import InterpreterPreferences from '../src/components/InterpreterPreferences';
import { I18nProvider } from '../src/i18n';

const config = {
  interpreterLanguages: ['en', 'ur'],
  offerBsl: true,
  collectPatientPrefs: ['remember_interpreter']
};

describe('InterpreterPreferences', () => {
  it('renders nothing when no languages are configured', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <InterpreterPreferences config={{ interpreterLanguages: [] }} value={{ requiresInterpreter: false }} onChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toBe('');
  });

  it('renders section when languages are available', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <InterpreterPreferences
          config={config}
          value={{ requiresInterpreter: true, preferredLanguages: ['en'], rememberSelection: true }}
          onChange={() => undefined}
          allowPersistence
        />
      </I18nProvider>
    );

    expect(html).toContain('Interpreter and accessibility preferences');
    expect(html).toContain('multiple');
    expect(html).toContain('Remember this preference on this device');
  });
});
