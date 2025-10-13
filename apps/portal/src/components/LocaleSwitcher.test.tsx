/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LocaleSwitcher from './LocaleSwitcher';
import { I18nProvider } from '../i18n';

describe('LocaleSwitcher', () => {
  it('associates label with select element', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(LocaleSwitcher))
    );

    expect(html).toMatch(/<label[^>]*for="[^"]+"/);
    expect(html).toMatch(/<select id="[^"]+"/);
  });
});
