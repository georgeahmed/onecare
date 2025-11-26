import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setQueueGatewayAuth } from '../adapters/gateway';

export type Role = 'clinician' | 'coordinator' | 'admin';

export interface ClinicSummary {
  id: string;
  name: string;
}

export interface AuthSession {
  userId: string;
  displayName: string;
  roles: Role[];
  clinics: ClinicSummary[];
  token: string;
  expiresAt?: string;
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  session: AuthSession | null;
  activeClinicId: string | null;
  activeClinic: ClinicSummary | null;
  login: (session: AuthSession) => void;
  logout: () => void;
  setActiveClinic: (clinicId: string) => void;
  hasRole: (role: Role | Role[]) => boolean;
}

const STORAGE_SESSION_KEY = 'onecare.clinician.auth.session';
const STORAGE_CLINIC_KEY = 'onecare.clinician.auth.activeClinic';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

const isDevMode = typeof import.meta !== 'undefined' ? import.meta.env?.MODE !== 'production' : true;
const parseDevLoginFlag = (raw: unknown): boolean => {
  if (raw === undefined || raw === null) return true; // default-on in dev for local demos
  const normalized = String(raw).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  return false;
};

export const isDevLoginEnabled = (): boolean => {
  if (!isDevMode) return false;
  const rawFlag = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_ENABLE_DEV_LOGIN : undefined;
  return parseDevLoginFlag(rawFlag);
};

const devLoginEnabled = isDevLoginEnabled();

export const createDevSession = (): AuthSession => ({
  userId: 'clinician-dev',
  displayName: 'Jamie Clinician',
  roles: ['clinician'],
  token: 'dev-token',
  expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  clinics: [
    { id: 'demo', name: 'Downtown Practice' },
    { id: 'north', name: 'Northside Clinic' }
  ]
});

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const ensureExpiry = (session: AuthSession): AuthSession => {
  const expiresAt = session.expiresAt && !Number.isNaN(new Date(session.expiresAt).getTime())
    ? session.expiresAt
    : new Date(Date.now() + SESSION_TTL_MS).toISOString();
  return { ...session, expiresAt };
};

const isExpired = (session: AuthSession | null | undefined): boolean => {
  if (!session?.expiresAt) return true;
  const expires = Number.isFinite(Number(session.expiresAt))
    ? new Date(Number(session.expiresAt))
    : new Date(session.expiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() <= Date.now();
};

const sanitizeSession = (session: AuthSession | null | undefined): AuthSession | null => {
  if (!session) return null;
  const roles: Role[] = Array.isArray(session.roles)
    ? session.roles.filter((role): role is Role => role === 'clinician' || role === 'coordinator' || role === 'admin')
    : [];
  const clinics = Array.isArray(session.clinics) ? session.clinics.filter((clinic) => clinic?.id && clinic?.name) : [];
  if (!session.userId || !session.displayName || roles.length === 0 || clinics.length === 0 || !session.token?.trim()) {
    return null;
  }
  return { ...session, roles, clinics, token: session.token.trim() };
};

const readStoredSession = (): AuthSession | null => {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_SESSION_KEY);
    if (!raw) return null;
    const parsed = sanitizeSession(JSON.parse(raw) as AuthSession);
    if (!parsed || !parsed.expiresAt || isExpired(parsed) || !parsed.token) {
      window.sessionStorage.removeItem(STORAGE_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeStoredSession = (session: AuthSession | null) => {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    if (!session) {
      window.sessionStorage.removeItem(STORAGE_SESSION_KEY);
      return;
    }
    window.sessionStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore storage failures
  }
};

const readStoredClinic = (): string | null => {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    return window.sessionStorage.getItem(STORAGE_CLINIC_KEY);
  } catch {
    return null;
  }
};

const writeStoredClinic = (clinicId: string | null) => {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    if (!clinicId) {
      window.sessionStorage.removeItem(STORAGE_CLINIC_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_CLINIC_KEY, clinicId);
    }
  } catch {
    // ignore storage failures
  }
};

interface AuthProviderProps {
  children: ReactNode;
  initialSession?: AuthSession | null;
}

export const AuthProvider = ({ children, initialSession }: AuthProviderProps) => {
  const initialisedRef = useRef(false);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [activeClinicId, setActiveClinicId] = useState<string | null>(null);
  const expiryTimeoutRef = useRef<number | null>(null);

  const clearExpiryTimeout = useCallback(() => {
    if (expiryTimeoutRef.current !== null) {
      window.clearTimeout(expiryTimeoutRef.current);
      expiryTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;

    if (initialSession !== undefined) {
      const sanitized = sanitizeSession(initialSession);
      const validSession = sanitized && !isExpired(sanitized) ? ensureExpiry(sanitized) : null;
      setSession(validSession);
      const clinicId = validSession?.clinics?.[0]?.id ?? null;
      setActiveClinicId(validSession ? clinicId : null);
      setStatus(validSession ? 'authenticated' : 'unauthenticated');
      return;
    }

    const storedSession = readStoredSession();
    if (storedSession && !isExpired(storedSession)) {
      const normalized = ensureExpiry(storedSession);
      setSession(normalized);
      const storedClinic = readStoredClinic();
      const derivedClinic = storedClinic && normalized.clinics.some((clinic) => clinic.id === storedClinic)
        ? storedClinic
        : normalized.clinics[0]?.id ?? null;
      setActiveClinicId(derivedClinic);
      setStatus('authenticated');
      return;
    }

    setStatus('unauthenticated');
  }, [initialSession]);

  useEffect(() => {
    setQueueGatewayAuth({
      userId: session?.userId ?? undefined,
      token: session?.token ?? undefined,
      clinicId: activeClinicId ?? undefined
    });
  }, [activeClinicId, session]);

  const activeClinic = useMemo(() => {
    if (!session || !activeClinicId) return null;
    return session.clinics.find((clinic) => clinic.id === activeClinicId) ?? null;
  }, [session, activeClinicId]);

  const logout = useCallback(() => {
    setSession(null);
    setActiveClinicId(null);
    writeStoredSession(null);
    writeStoredClinic(null);
    setStatus('unauthenticated');
    clearExpiryTimeout();
  }, [clearExpiryTimeout]);

  const login = useCallback(
    (nextSession: AuthSession) => {
      const sanitized = sanitizeSession(nextSession);
      if (!sanitized) {
        logout();
        return;
      }
      const normalized = ensureExpiry(sanitized);
      if (isExpired(normalized)) {
        logout();
        return;
      }
      setSession(normalized);
      const clinicId = normalized.clinics[0]?.id ?? null;
      setActiveClinicId(clinicId);
      writeStoredSession(normalized);
      writeStoredClinic(clinicId);
      setStatus('authenticated');
    },
    [logout]
  );

  const setActiveClinic = useCallback(
    (clinicId: string) => {
      if (!session) return;
      const available = session.clinics.find((clinic) => clinic.id === clinicId);
      if (!available) return;
      setActiveClinicId(clinicId);
      writeStoredClinic(clinicId);
    },
    [session]
  );

  const hasRole = useCallback(
    (role: Role | Role[]) => {
      if (!session) return false;
      const required = Array.isArray(role) ? role : [role];
      return required.some((item) => session.roles.includes(item));
    },
    [session]
  );

  // Provide a dev convenience: if unauthenticated and dev mode, expose helper
  useEffect(() => {
    if (!isDevMode || !devLoginEnabled) return;
    if (status === 'unauthenticated' && !session) {
      // allow F12 login helper for quick demos
      (window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__ = () => {
        if (!devLoginEnabled) return;
        login(createDevSession());
      };
    }
    return () => {
      if ((window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__) {
        delete (window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__;
      }
    };
  }, [devLoginEnabled, login, session, status]);

  useEffect(() => {
    clearExpiryTimeout();
    if (!session || !session.expiresAt) return;
    const expiresAtMs = new Date(session.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) return;
    const delay = Math.max(0, expiresAtMs - Date.now());
    expiryTimeoutRef.current = window.setTimeout(() => {
      logout();
    }, delay);
  }, [session, clearExpiryTimeout, logout]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      activeClinicId,
      activeClinic,
      login,
      logout,
      setActiveClinic,
      hasRole
    }),
    [status, session, activeClinicId, activeClinic, login, logout, setActiveClinic, hasRole]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const AuthContextInternal = AuthContext;
