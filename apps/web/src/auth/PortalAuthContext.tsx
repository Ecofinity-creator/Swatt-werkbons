import type { CustomerPortalIdentity } from '@swatt/shared-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiRequestError, portalApi } from '../api/client';

/**
 * Klantportaal (sectie 30) — bewust een eigen context, volledig los van
 * AuthContext.tsx: een Customer is geen User/Employee, heeft een eigen
 * sessiecookie (customer-portal-session.service.ts) en nooit toegang tot de
 * rest van de app. Enkel gemonteerd binnen de /klantportaal/*-routes (zie
 * App.tsx) — zo doet geen enkele medewerker-/adminpagina de extra
 * /portal/me-aanroep bij het laden.
 */
interface PortalAuthContextValue {
  customer: CustomerPortalIdentity | null;
  /** true zolang de eerste /portal/me-check nog loopt (voorkomt een login-flits bij herladen). */
  isLoading: boolean;
  setCustomer: (customer: CustomerPortalIdentity) => void;
  logout: () => Promise<void>;
}

const PortalAuthContext = createContext<PortalAuthContextValue | null>(null);

export function PortalAuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomerState] = useState<CustomerPortalIdentity | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    portalApi
      .me()
      .then((response) => setCustomerState(response.customer))
      .catch(() => setCustomerState(null))
      .finally(() => setIsLoading(false));
  }, []);

  const setCustomer = useCallback((next: CustomerPortalIdentity) => setCustomerState(next), []);

  const logout = useCallback(async () => {
    await portalApi.logout();
    setCustomerState(null);
  }, []);

  const value = useMemo(() => ({ customer, isLoading, setCustomer, logout }), [customer, isLoading, setCustomer, logout]);

  return <PortalAuthContext.Provider value={value}>{children}</PortalAuthContext.Provider>;
}

export function usePortalAuth(): PortalAuthContextValue {
  const context = useContext(PortalAuthContext);
  if (!context) {
    throw new Error('usePortalAuth() moet binnen een <PortalAuthProvider> gebruikt worden.');
  }
  return context;
}

export { ApiRequestError };
