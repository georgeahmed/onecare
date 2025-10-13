import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import en from './messages/en';
import es from './messages/es';

export type Locale = 'en' | 'es';

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const messages: Record<Locale, Record<string, string>> = {
  en,
  es
};

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export const LOCALE_STORAGE_KEY = 'onecare.portal.locale';

const isSupportedLocale = (value: string | null | undefined): value is Locale => value === 'en' || value === 'es';

const readStoredLocale = (): Locale | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    return null;
  }
};

export const persistLocaleValue = (value: Locale): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    // ignore storage failures
  }
};

export const resolveInitialLocale = (): Locale => {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }
  if (typeof navigator !== 'undefined') {
    const language = navigator.language?.split?.('-')?.[0];
    if (isSupportedLocale(language)) {
      return language;
    }
  }
  return 'en';
};

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocaleValue(next);
  }, []);

  const contextValue = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  useEffect(() => {
    applyDocumentLanguage(locale);
  }, [locale]);

  return (
    <LocaleContext.Provider value={contextValue}>
      <IntlProvider locale={locale} messages={messages[locale]} defaultLocale="en">
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
};

export const useLocale = (): LocaleContextValue => {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used within an I18nProvider');
  }
  return context;
};

export const supportedLocales: Locale[] = ['en', 'es'];

export const applyDocumentLanguage = (value: Locale): void => {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.lang = value;
};
