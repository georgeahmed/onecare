import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ClinicianTheme = 'light' | 'high-contrast';
const STORAGE_KEY = 'onecare.clinician.theme';

type ThemeCtx = { theme: ClinicianTheme; setTheme: (t: ClinicianTheme) => void };
const ThemeContext = createContext<ThemeCtx | undefined>(undefined);

const read = (): ClinicianTheme | null => {
  try { const v = window.localStorage?.getItem(STORAGE_KEY); return v === 'high-contrast' ? 'high-contrast' : v === 'light' ? 'light' : null; } catch { return null; }
};

const preferHC = (): ClinicianTheme => {
  try { return window.matchMedia?.('(prefers-contrast: more)').matches ? 'high-contrast' : 'light'; } catch { return 'light'; }
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setThemeState] = useState<ClinicianTheme>(() => read() ?? preferHC());
  const mounted = useRef(false);
  const setTheme = useCallback((t: ClinicianTheme) => { setThemeState(t); try { window.localStorage?.setItem(STORAGE_KEY, t); } catch {} }, []);
  useEffect(() => {
    const root = document?.documentElement; if (!root) return;
    root.classList.remove('theme-high-contrast');
    if (theme === 'high-contrast') root.classList.add('theme-high-contrast');
    if (!mounted.current) mounted.current = true;
  }, [theme]);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeCtx => {
  const v = useContext(ThemeContext); if (!v) throw new Error('useTheme must be used within ThemeProvider'); return v;
};

