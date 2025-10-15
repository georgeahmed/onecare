/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistTheme, resolveInitialTheme, THEME_STORAGE_KEY, type PortalTheme } from '../src/theme';

const stubWindow = (options: { storage?: Storage; prefersContrast?: boolean; prefersDark?: boolean } = {}) => {
  const store = new Map<string, string>();
  const storage: Storage =
    options.storage ??
    ({
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return null;
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
        return null;
      })
    } as unknown as Storage);

  const matchMedia = vi.fn((query: string) => {
    if (query === '(prefers-contrast: more)') {
      return { matches: options.prefersContrast ?? false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as MediaQueryList;
    }
    if (query === '(prefers-color-scheme: dark)') {
      return { matches: options.prefersDark ?? false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as MediaQueryList;
    }
    return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as MediaQueryList;
  });

  vi.stubGlobal('window', { localStorage: storage, matchMedia });
  vi.stubGlobal('document', { documentElement: { classList: { remove: vi.fn(), add: vi.fn() }, dataset: {} } });

  return { storage, store, matchMedia };
};

describe('theme helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads stored theme when available', () => {
    const { storage } = stubWindow();
    storage.getItem = vi.fn().mockReturnValue('dark');

    const theme = resolveInitialTheme();

    expect(theme).toBe('dark');
    expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });

  it('falls back to high contrast when system preference set', () => {
    stubWindow({ prefersContrast: true });

    const theme = resolveInitialTheme();

    expect(theme).toBe('high-contrast');
  });

  it('falls back to dark when system preference set', () => {
    stubWindow({ prefersDark: true });

    const theme = resolveInitialTheme();

    expect(theme).toBe('dark');
  });

  it('persists theme without throwing when storage available', () => {
    const { storage, store } = stubWindow();

    persistTheme('dark');

    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('ignores storage failures gracefully', () => {
    const failingStorage: Storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error('denied');
      }),
      removeItem: vi.fn()
    } as unknown as Storage;

    stubWindow({ storage: failingStorage });

    expect(() => persistTheme('light')).not.toThrow();
  });
});
