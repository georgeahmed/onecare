/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import App from '../src/App';

const renderApp = () =>
  renderToStaticMarkup(
    <StaticRouter location="/intake">
      <App />
    </StaticRouter>
  );

describe('App shell accessibility scaffolding', () => {
  it('renders skip links targeting navigation and main content', () => {
    const html = renderApp();

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('href="#primary-navigation"');
  });

  it('labels primary navigation for assistive technology', () => {
    const html = renderApp();

    expect(html).toMatch(/nav id="primary-navigation"[^>]*aria-label="[^"]+"/);
  });
});
