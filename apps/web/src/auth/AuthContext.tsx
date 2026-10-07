import type { AuthenticatedUser } from '@swatt/shared-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { roleAtLeast } from '@swatt/shared-types';
import { ApiRequestError, authApi, SESSION_EXPIRED_EVENT, teamleaderApi } from '../api/client';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  /** true zolang de eerste /auth/me-check nog loopt (voorkomt een login-flits bij herladen). */
  isLoading: boolean;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    authApi
      .me()
      .then((response) => setUser(response.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  // Bugreport 21/9/2026 ("ik krijg continu de melding dat ik niet ingelogd
  // ben, niettegenstaande ik wel ben ingelogd" + "kan ook niet uitloggen")
  // — zie SESSION_EXPIRED_EVENT in api/client.ts voor de volledige uitleg.
  // Zonder deze listener bleef de UI "Ingelogd als ..." tonen (uit de
  // eenmalige /auth/me hierboven, mogelijk via de service worker uit cache)
  // terwijl elke echte aanroep intussen 401 gaf — een doodlopend schermpje.
  // Deze listener wist de state meteen zodra ÉÉN echte aanroep bevestigt dat
  // de sessie weg is, waarna RequireAuth (App.tsx) vanzelf naar /login valt.
  useEffect(() => {
    function handleSessionExpired() {
      setUser(null);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  const login = useCallback(async (email: string, password: string, rememberMe = false) => {
    const response = await authApi.login(email, password, rememberMe);
    setUser(response.user);

    // Klantvraag 7/10/2026: bij elke login van een supervisor/admin de
    // Teamleader-projecten synchroniseren. Bewust NIET afgewacht — inloggen
    // mag hier nooit trager door worden, en een mislukte sync (bv. Teamleader
    // (nog) niet gekoppeld of tijdelijk onbereikbaar) mag het inloggen nooit
    // blokkeren. De manuele knop in Instellingen → Teamleader-integratie
    // blijft de plek om een fout te zien en opnieuw te proberen.
    if (roleAtLeast(response.user.role, 'SUPERVISOR')) {
      teamleaderApi.syncProjects().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('Automatische projectensync na login mislukt:', err);
      });
    }
  }, []);

  const logout = useCallback(async () => {
    // Bewust try/finally: ook wanneer de server-aanroep zelf faalt (bv. de
    // sessie was al verlopen — exact het "kan ook niet uitloggen"-scenario
    // hierboven), moet de gebruiker lokaal alsnog uitgelogd geraken, anders
    // biedt de "Uitloggen"-knop geen enkele uitweg meer.
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, isLoading, login, logout }), [user, isLoading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() moet binnen een <AuthProvider> gebruikt worden.');
  }
  return context;
}

export { ApiRequestError };
