/// <reference types="vitest/globals" />
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import App from '../src/App';

describe('Clinician i18n labels', () => {
  it('renders nav labels in English by default', () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/queue">
        <App />
      </StaticRouter>
    );
    expect(html).toContain('Queue');
    expect(html).toContain('Settings');
  });
});

