/// <reference types="vitest/globals" />

import axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { ThemeProvider } from '../src/theme';
import App from '../src/App';

type AxeResults = Awaited<ReturnType<typeof axe.run>>;
type AxeViolation = AxeResults['violations'][number];

const runAxeForRoute = async (initialPath: string): Promise<AxeViolation[]> => {
  const url = new URL(`http://localhost${initialPath}`);
  if (typeof window !== 'undefined' && window.localStorage) {
    if (url.searchParams.has('locale')) {
      window.localStorage.setItem('onecare.portal.locale', url.searchParams.get('locale') ?? 'en');
    } else {
      window.localStorage.removeItem('onecare.portal.locale');
    }
  }

  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(
        I18nProvider,
        null,
        createElement(
          ThemeProvider,
          null,
          createElement(App)
        )
      )
    )
  );

  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${markup}</body></html>`, {
    url: `http://localhost${initialPath}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const resolvedLocale = url.searchParams.get('locale') ?? 'en';
  const langValue = resolvedLocale === 'en' ? 'en-US' : resolvedLocale;
  dom.window.document.documentElement.lang = langValue;
  dom.window.document.documentElement.setAttribute('xml:lang', langValue);

  const axeScript = axe.source;
  dom.window.eval(axeScript);
  const axeRuntime = (dom.window as typeof dom.window & { axe: typeof axe }).axe;

  if (!dom.window.document.title) {
    dom.window.document.title = 'Vecells Portal';
  }

  const results = await axeRuntime.run(dom.window.document, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa']
    }
  });

  dom.window.close();

  return results.violations;
};

const describeViolations = (violations: AxeViolation[]): string =>
  violations
    .map((violation) => {
      const targets =
        violation.nodes?.map((node) => (Array.isArray(node.target) ? node.target.join(' | ') : '')).filter(Boolean) ??
        [];
      const targetText = targets.length > 0 ? ` [targets: ${targets.join('; ')}]` : '';
      return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}${targetText}`;
    })
    .join('\n');

describe('Accessibility audit (axe)', () => {
  const routes: Array<[string, string]> = [
    ['/intake', 'Intake landing'],
    ['/booking', 'Booking start'],
    ['/booking?locale=ar', 'Booking RTL']
  ];

  it.each(routes)('has no serious accessibility violations: %s (%s)', async (path) => {
    const violations = await runAxeForRoute(path);
    const seriousOrWorse = violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    expect(seriousOrWorse, describeViolations(seriousOrWorse)).toHaveLength(0);
  });
});
