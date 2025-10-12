/// <reference types="vitest/globals" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ErrorAlert from './ErrorAlert';
import type { ErrorEnvelope } from '../lib/types';

const buildEnvelope = (overrides: Partial<ErrorEnvelope['error']> = {}): ErrorEnvelope => ({
  error: {
    code: 'invalid_input',
    message: 'Invalid input provided',
    ...overrides
  },
  correlationId: 'corr-123'
});

describe('ErrorAlert', () => {
  it('renders friendly copy for known error codes', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorAlert, {
        error: buildEnvelope(),
        id: 'error-alert'
      })
    );

    expect(html).toContain('Check the highlighted details');
    expect(html).toContain('Support reference');
    expect(html).toContain('corr-123');
  });

  it('falls back to server message when code is unknown', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorAlert, {
        error: {
          error: { code: 'strange_code', message: 'Unexpected failure' }
        }
      })
    );

    expect(html).toContain('Unexpected failure');
  });

  it('renders retry button and support link when provided', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorAlert, {
        error: buildEnvelope({ code: 'busy' }),
        onRetry: () => undefined,
        supportUrl: 'mailto:test@example.com'
      })
    );

    expect(html).toContain('Try again');
    expect(html).toContain('Contact support');
    expect(html).toContain('mailto:test@example.com');
  });
});
