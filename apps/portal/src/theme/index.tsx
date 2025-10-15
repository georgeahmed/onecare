import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

export type PortalTheme = 'light' | 'dark' | 'high-contrast';

export const THEME_STORAGE_KEY = 'onecare.portal.theme';

interface ThemeContextValue {
  theme: PortalTheme;
  setTheme: (theme: PortalTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const applyHtmlTheme = (theme: PortalTheme): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('theme-dark', 'theme-high-contrast');
  if (theme === 'dark') {
    root.classList.add('theme-dark');
  }
  if (theme === 'high-contrast') {
    root.classList.add('theme-high-contrast');
  }
  root.dataset.theme = theme;
};

const readStoredTheme = (): PortalTheme | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'high-contrast') {
      return stored;
    }
  } catch {
    return null;
  }
  return null;
};

const detectSystemTheme = (): PortalTheme => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  try {
    if (window.matchMedia('(prefers-contrast: more)').matches) {
      return 'high-contrast';
    }
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    return 'light';
  }
  return 'light';
};

export const resolveInitialTheme = (): PortalTheme => readStoredTheme() ?? detectSystemTheme();

export const persistTheme = (theme: PortalTheme): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore failures so the UI remains responsive
  }
};

const disableTransitionsTemporarily = (root: HTMLElement): void => {
  root.setAttribute('data-theme-transition', 'true');
  window.setTimeout(() => {
    root.removeAttribute('data-theme-transition');
  }, 0);
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setThemeState] = useState<PortalTheme>(resolveInitialTheme);
  const hasMountedRef = useRef(false);

  const setTheme = useCallback((next: PortalTheme) => {
    setThemeState(next);
    persistTheme(next);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (hasMountedRef.current) {
      disableTransitionsTemporarily(root);
    } else {
      hasMountedRef.current = true;
    }
    applyHtmlTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (readStoredTheme()) {
      return;
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const contrast = window.matchMedia?.('(prefers-contrast: more)');
    const handleChange = () => {
      if (readStoredTheme()) {
        return;
      }
      setThemeState(detectSystemTheme());
    };
    media?.addEventListener?.('change', handleChange);
    contrast?.addEventListener?.('change', handleChange);
    return () => {
      media?.removeEventListener?.('change', handleChange);
      contrast?.removeEventListener?.('change', handleChange);
    };
  }, []);

  useEffect(() => {
    applyHtmlTheme(theme);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
