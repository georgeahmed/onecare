/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { applyDocumentLanguage } from '../src/i18n';

describe('applyDocumentLanguage', () => {
  it('updates document language attribute when document is available', () => {
    const originalDocument = (globalThis as { document?: Document }).document;
    const stub = { documentElement: { lang: 'en' } } as unknown as Document;
    (globalThis as { document?: Document }).document = stub;

    applyDocumentLanguage('es');

    expect(stub.documentElement.lang).toBe('es');
    if (originalDocument) {
      (globalThis as { document?: Document }).document = originalDocument;
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  });

  it('does not throw when document is undefined', () => {
    const originalDocument = (globalThis as { document?: Document }).document;
    delete (globalThis as { document?: Document }).document;

    expect(() => applyDocumentLanguage('fr')).not.toThrow();

    if (originalDocument) {
      (globalThis as { document?: Document }).document = originalDocument;
    }
  });
});
