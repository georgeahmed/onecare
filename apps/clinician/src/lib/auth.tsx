import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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

const isDevMode = typeof import.meta !== 'undefined' ? import.meta.env?.MODE !== 'production' : true;

export const createDevSession = (): AuthSession => ({
  userId: 'clinician-dev',
  displayName: 'Jamie Clinician',
  roles: ['clinician'],
  token: 'dev-token',
  clinics: [
    { id: 'demo', name: 'Downtown Practice' },
    { id: 'north', name: 'Northside Clinic' }
  ]
});

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const isExpired = (session: AuthSession | null | undefined): boolean => {
  if (!session?.expiresAt) return false;
  const expires = Number.isFinite(Number(session.expiresAt))
    ? new Date(Number(session.expiresAt))
    : new Date(session.expiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return expires.getTime() <= Date.now();
};

const readStoredSession = (): AuthSession | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || !parsed.userId || !Array.isArray(parsed.clinics)) return null;
    if (isExpired(parsed)) {
      window.localStorage.removeItem(STORAGE_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeStoredSession = (session: AuthSession | null) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!session) {
      window.localStorage.removeItem(STORAGE_SESSION_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore storage failures
  }
};

const readStoredClinic = (): string | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(STORAGE_CLINIC_KEY);
  } catch {
    return null;
  }
};

const writeStoredClinic = (clinicId: string | null) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!clinicId) {
      window.localStorage.removeItem(STORAGE_CLINIC_KEY);
    } else {
      window.localStorage.setItem(STORAGE_CLINIC_KEY, clinicId);
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

  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;

    if (initialSession !== undefined) {
      const validSession = initialSession && !isExpired(initialSession) ? initialSession : null;
      setSession(validSession);
      const clinicId = validSession?.clinics?.[0]?.id ?? null;
      setActiveClinicId(validSession ? clinicId : null);
      setStatus(validSession ? 'authenticated' : 'unauthenticated');
      return;
    }

    const storedSession = readStoredSession();
    if (storedSession && !isExpired(storedSession)) {
      setSession(storedSession);
      const storedClinic = readStoredClinic();
      const derivedClinic = storedClinic && storedSession.clinics.some((clinic) => clinic.id === storedClinic)
        ? storedClinic
        : storedSession.clinics[0]?.id ?? null;
      setActiveClinicId(derivedClinic);
      setStatus('authenticated');
      return;
    }

    setStatus('unauthenticated');
  }, [initialSession]);

  const activeClinic = useMemo(() => {
    if (!session || !activeClinicId) return null;
    return session.clinics.find((clinic) => clinic.id === activeClinicId) ?? null;
  }, [session, activeClinicId]);

  const login = useCallback(
    (nextSession: AuthSession) => {
      setSession(nextSession);
      const clinicId = nextSession.clinics[0]?.id ?? null;
      setActiveClinicId(clinicId);
      writeStoredSession(nextSession);
      writeStoredClinic(clinicId);
      setStatus('authenticated');
    },
    []
  );

  const logout = useCallback(() => {
    setSession(null);
    setActiveClinicId(null);
    writeStoredSession(null);
    writeStoredClinic(null);
    setStatus('unauthenticated');
  }, []);

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
    if (!isDevMode) return;
    if (status === 'unauthenticated' && !session) {
      // allow F12 login helper for quick demos
      (window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__ = () => {
        const devSession = createDevSession();
        login(devSession);
      };
    }
    return () => {
      if ((window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__) {
        delete (window as typeof window & { __ONECARE_DEV_LOGIN__?: () => void }).__ONECARE_DEV_LOGIN__;
      }
    };
  }, [login, session, status]);

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
