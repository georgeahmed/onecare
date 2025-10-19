import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import enMessages from './messages/en';
import { generatePseudoMessages } from './pseudo';
import { recordRumEvent, safeLog } from '../lib/telemetry';

const DEV_PSEUDO_LOCALE = 'pseudo' as const;
const REAL_LOCALES = ['en', 'es', 'ar'] as const;

export type RealLocale = typeof REAL_LOCALES[number];
export type Locale = RealLocale | typeof DEV_PSEUDO_LOCALE;

type LocaleDirection = 'ltr' | 'rtl';

type LocaleDefinition = {
  direction: LocaleDirection;
  labelId: string;
  devOnly?: boolean;
};

type LocaleStatus = 'ready' | 'loading' | 'fallback';

type LocaleContextValue = {
  locale: Locale;
  direction: LocaleDirection;
  status: LocaleStatus;
  hasLocaleUpdate: boolean;
  lastUpdatedAt: number | null;
  setLocale: (locale: Locale) => void;
  refreshLocale: () => void;
};

const LOCALE_DEFINITIONS: Record<Locale, LocaleDefinition> = {
  en: { direction: 'ltr', labelId: 'locale.name.en' },
  es: { direction: 'ltr', labelId: 'locale.name.es' },
  ar: { direction: 'rtl', labelId: 'locale.name.ar' },
  [DEV_PSEUDO_LOCALE]: { direction: 'ltr', labelId: 'locale.name.pseudo', devOnly: true }
};

const LOCALE_MESSAGE_LOADERS: Record<RealLocale, () => Promise<Record<string, string>>> = {
  en: async () => enMessages,
  es: async () => import('./messages/es').then((module) => module.default),
  ar: async () => import('./messages/ar').then((module) => module.default)
};

const messageCache = new Map<Locale, Record<string, string>>([[ 'en', enMessages ]]);

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export const LOCALE_STORAGE_KEY = 'onecare.portal.locale';
const LOCALE_CACHE_PREFIX = 'onecare.portal.locale.messages.';

type LocaleCacheEnvelope = {
  updatedAt: number;
  messages: Record<string, string>;
};

const FALLBACK_MESSAGES: Record<string, string> = { ...enMessages };

const getLocaleCacheKey = (locale: Locale): string => `${LOCALE_CACHE_PREFIX}${locale}`;

const areMessagesEqual = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => a[key] === b[key]);
};

type MaybeNodeProcess = { process?: { env?: Record<string, string | undefined> } };

const nodeEnv =
  typeof globalThis !== 'undefined'
    ? ((globalThis as MaybeNodeProcess).process?.env?.NODE_ENV ?? undefined)
    : undefined;

const isDevEnvironment =
  typeof import.meta !== 'undefined' ? import.meta.env?.DEV ?? false : nodeEnv !== 'production';

const availableLocalesList: Locale[] = (Object.keys(LOCALE_DEFINITIONS) as Locale[]).filter((key) => {
  const definition = LOCALE_DEFINITIONS[key];
  return !definition.devOnly || isDevEnvironment;
});

const supportedRealLocales = REAL_LOCALES.slice();

const isSupportedLocale = (value: string | null | undefined): value is Locale => {
  if (!value) return false;
  return availableLocalesList.includes(value as Locale);
};

const isSupportedRealLocale = (value: string | null | undefined): value is RealLocale => {
  if (!value) return false;
  return supportedRealLocales.includes(value as RealLocale);
};

const readStoredLocale = (): Locale | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? (stored as Locale) : null;
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
      return language as Locale;
    }
    if (isSupportedRealLocale(language)) {
      return language as RealLocale;
    }
  }
  return 'en';
};

const loadLocaleMessages = async (locale: Locale): Promise<Record<string, string>> => {
  if (messageCache.has(locale)) {
    return messageCache.get(locale)!;
  }
  if (locale === DEV_PSEUDO_LOCALE) {
    const base = await loadLocaleMessages('en');
    if (messageCache.has(DEV_PSEUDO_LOCALE)) {
      return messageCache.get(DEV_PSEUDO_LOCALE)!;
    }
    const pseudo = generatePseudoMessages(base);
    messageCache.set(DEV_PSEUDO_LOCALE, pseudo);
    return pseudo;
  }
  const loader = LOCALE_MESSAGE_LOADERS[locale];
  const resolved = await loader();
  messageCache.set(locale, resolved);
  return resolved;
};

export const getAvailableLocales = (): Locale[] => availableLocalesList.slice();

export const getRealLocales = (): RealLocale[] => supportedRealLocales.slice();

export const getLocaleMetadata = (locale: Locale): LocaleDefinition => LOCALE_DEFINITIONS[locale];

export const getLocaleDirection = (locale: Locale): LocaleDirection => LOCALE_DEFINITIONS[locale].direction;

const readCachedLocaleEnvelope = (locale: Locale): LocaleCacheEnvelope | null => {
  if (messageCache.has(locale)) {
    return {
      updatedAt: Date.now(),
      messages: messageCache.get(locale)!,
    };
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(getLocaleCacheKey(locale));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocaleCacheEnvelope | Record<string, string>;
    if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
      const envelope = parsed as LocaleCacheEnvelope;
      messageCache.set(locale, envelope.messages);
      return envelope;
    }
    if (parsed && typeof parsed === 'object') {
      const legacyMessages = parsed as Record<string, string>;
      messageCache.set(locale, legacyMessages);
      return {
        updatedAt: 0,
        messages: legacyMessages,
      };
    }
    return null;
  } catch {
    return null;
  }
};

const writeLocaleCache = (locale: Locale, messages: Record<string, string>): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    const envelope: LocaleCacheEnvelope = {
      updatedAt: Date.now(),
      messages
    };
    window.localStorage.setItem(getLocaleCacheKey(locale), JSON.stringify(envelope));
  } catch {
    // ignore cache write errors
  }
};

export const cacheLocaleMessages = (locale: Locale, messages: Record<string, string>): void => {
  messageCache.set(locale, messages);
  writeLocaleCache(locale, messages);
};

export const readCachedLocaleMessages = (locale: Locale): Record<string, string> | null => {
  const envelope = readCachedLocaleEnvelope(locale);
  return envelope ? envelope.messages : null;
};

export const applyDocumentLanguage = (value: Locale): void => {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.lang = value === DEV_PSEUDO_LOCALE ? 'en' : value;
};

export const applyDocumentDirection = (direction: LocaleDirection): void => {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.dir = direction;
};

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  const [messages, setMessages] = useState<Record<string, string>>(() => messageCache.get(locale) ?? enMessages);
  const [direction, setDirection] = useState<LocaleDirection>(() => getLocaleDirection(locale));
  const [status, setStatus] = useState<LocaleStatus>(() => (messageCache.has(locale) ? 'ready' : 'loading'));
  const [hasLocaleUpdate, setHasLocaleUpdate] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setStatus((previous) => (previous === 'fallback' ? previous : 'loading'));
    setHasLocaleUpdate(false);

    const cachedEnvelope = readCachedLocaleEnvelope(locale);
    if (cachedEnvelope) {
      setMessages(cachedEnvelope.messages);
      setLastUpdatedAt(cachedEnvelope.updatedAt);
      setStatus('ready');
    } else if (messageCache.has(locale)) {
      setMessages(messageCache.get(locale)!);
      setLastUpdatedAt(Date.now());
      setStatus('ready');
    } else if (locale === 'en') {
      setMessages(FALLBACK_MESSAGES);
      setLastUpdatedAt(Date.now());
      setStatus('ready');
    }

    loadLocaleMessages(locale)
      .then((loaded) => {
        if (cancelled) return;
        cacheLocaleMessages(locale, loaded);
        const cachedMessages = cachedEnvelope?.messages;
        const different = cachedMessages ? !areMessagesEqual(cachedMessages, loaded) : false;
        setMessages(loaded);
        setStatus('ready');
        setLastUpdatedAt(Date.now());
        setHasLocaleUpdate(different);
        if (different) {
          recordRumEvent('i18n.cache.updated', { locale });
          safeLog('i18n.cache.updated', { locale });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setMessages(FALLBACK_MESSAGES);
        setStatus('fallback');
        setLastUpdatedAt(null);
        setHasLocaleUpdate(false);
        const message =
          error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
            ? error.message
            : 'Unknown error';
        recordRumEvent('i18n.load.fallback', { locale, message });
        safeLog('i18n.load.fallback', { locale, message });
      });

    return () => {
      cancelled = true;
    };
  }, [locale, reloadGeneration]);

  useEffect(() => {
    const nextDirection = getLocaleDirection(locale);
    setDirection(nextDirection);
  }, [locale]);

  useEffect(() => {
    applyDocumentLanguage(locale);
  }, [locale]);

  useEffect(() => {
    applyDocumentDirection(direction);
  }, [direction]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    setStatus(messageCache.has(next) ? 'ready' : 'loading');
    setHasLocaleUpdate(false);
    setLastUpdatedAt(null);
    persistLocaleValue(next);
  }, []);

  const refreshLocale = useCallback(() => {
    setReloadGeneration((value) => value + 1);
  }, []);

  const contextValue = useMemo(
    () => ({
      locale,
      direction,
      status,
      hasLocaleUpdate,
      lastUpdatedAt,
      setLocale,
      refreshLocale
    }),
    [locale, direction, status, hasLocaleUpdate, lastUpdatedAt, setLocale, refreshLocale]
  );

  return (
    <LocaleContext.Provider value={contextValue}>
      <IntlProvider locale={locale === DEV_PSEUDO_LOCALE ? 'en' : locale} messages={messages} defaultLocale="en">
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

export const supportedLocales: RealLocale[] = supportedRealLocales;
