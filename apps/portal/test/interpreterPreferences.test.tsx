/// <reference types="vitest/globals" />

import { renderToStaticMarkup } from 'react-dom/server';
import InterpreterPreferences from '../src/components/InterpreterPreferences';
import { I18nProvider } from '../src/i18n';

const config = {
  interpreterLanguages: ['en', 'ur'],
  offerBsl: true,
  collectPatientPrefs: []
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
          value={{ requiresInterpreter: true, preferredLanguage: 'en' }}
          onChange={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Interpreter and accessibility preferences');
    expect(html).toContain('Select a language');
  });
});
