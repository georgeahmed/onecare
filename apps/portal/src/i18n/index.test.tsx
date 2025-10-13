/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentLanguage, LOCALE_STORAGE_KEY, persistLocaleValue, resolveInitialLocale } from './index';

const stubWindow = (overrides: Partial<Window> = {}) => {
  const store = new Map<string, string>();
  const localStorage = overrides.localStorage ?? {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return null;
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
      return null;
    })
  };
  const navigator = overrides.navigator ?? { language: 'en-US' };

  vi.stubGlobal('window', { localStorage, navigator, ...overrides });
  vi.stubGlobal('navigator', navigator);

  return { localStorage, store };
};

describe('i18n locale resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists and retrieves stored locale preference', () => {
    const { localStorage, store } = stubWindow();

    persistLocaleValue('es');

    expect(store.get(LOCALE_STORAGE_KEY)).toBe('es');
    expect(localStorage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, 'es');
    expect(resolveInitialLocale()).toBe('es');
    expect(localStorage.getItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY);
  });

  it('falls back to navigator language when storage is empty', () => {
    const { localStorage } = stubWindow({ navigator: { language: 'es-MX' } });
    localStorage.getItem = vi.fn().mockReturnValue(null);

    expect(resolveInitialLocale()).toBe('es');
  });

  it('returns default locale when navigator language unsupported', () => {
    stubWindow({ navigator: { language: 'fr-FR' } });

    expect(resolveInitialLocale()).toBe('en');
  });

  it('ignores storage errors gracefully', () => {
    const failingStorage = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      removeItem: vi.fn(() => null)
    } as unknown as Storage;

    stubWindow({ localStorage: failingStorage });

    expect(() => persistLocaleValue('es')).not.toThrow();
    expect(resolveInitialLocale()).toBe('en');
  });

  it('applies language attribute when document is available', () => {
    const documentMock = {
      documentElement: { lang: 'en' }
    } as unknown as Document;

    vi.stubGlobal('document', documentMock);

    applyDocumentLanguage('es');

    expect(document.documentElement.lang).toBe('es');
  });
});
