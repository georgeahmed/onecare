/// <reference types="vitest/globals" />

import axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';

type AxeResults = Awaited<ReturnType<typeof axe.run>>;
type AxeViolation = AxeResults['violations'][number];

const runAxeForRoute = async (initialPath: string): Promise<AxeViolation[]> => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(App)
    )
  );

  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${markup}</body></html>`, {
    url: `http://localhost${initialPath}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });

  const axeScript = axe.source;
  dom.window.eval(axeScript);
  const axeRuntime = (dom.window as typeof dom.window & { axe: typeof axe }).axe;

  if (!dom.window.document.title) {
    dom.window.document.title = 'OneCare Portal';
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
    .map((violation) => `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}`)
    .join('\n');

describe('Accessibility audit (axe)', () => {
  const routes: Array<[string, string]> = [
    ['/intake', 'Intake landing'],
    ['/booking', 'Booking start']
  ];

  it.each(routes)('has no serious accessibility violations: %s (%s)', async (path) => {
    const violations = await runAxeForRoute(path);
    const seriousOrWorse = violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    expect(seriousOrWorse, describeViolations(seriousOrWorse)).toHaveLength(0);
  });
});
