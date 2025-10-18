import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import en from './messages/en';
import es from './messages/es';

export type Locale = 'en' | 'es';

type LocaleContextValue = { locale: Locale; setLocale: (l: Locale) => void };
const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

const messages: Record<Locale, Record<string, string>> = { en, es };
const STORAGE_KEY = 'onecare.clinician.locale';

const readStored = (): Locale | null => {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return raw === 'en' || raw === 'es' ? (raw as Locale) : null;
  } catch { return null; }
};

const resolveInitial = (): Locale => readStored() ?? (navigator.language?.startsWith('es') ? 'es' : 'en');

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(resolveInitial);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l); try { window.localStorage?.setItem(STORAGE_KEY, l); } catch {}
  }, []);
  useEffect(() => { if (document?.documentElement) document.documentElement.lang = locale; }, [locale]);
  const ctx = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return (
    <LocaleContext.Provider value={ctx}>
      <IntlProvider locale={locale} messages={messages[locale]} defaultLocale="en">{children}</IntlProvider>
    </LocaleContext.Provider>
  );
};

export const useLocale = (): LocaleContextValue => {
  const v = useContext(LocaleContext);
  if (!v) throw new Error('useLocale must be used within I18nProvider');
  return v;
};

