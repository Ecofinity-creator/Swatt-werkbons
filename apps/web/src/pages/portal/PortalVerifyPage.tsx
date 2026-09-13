import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiRequestError, portalApi } from '../../api/client';
import { usePortalAuth } from '../../auth/PortalAuthContext';
import { Logo } from '../../components/Logo';

/**
 * Klantportaal (sectie 30) — verwerkt de `?token=`-link uit de inlog-e-mail:
 * wisselt het token in voor een sessiecookie (portalApi.verify()) en stuurt
 * daarna door. Geen <RequirePortalAuth>-wrapper nodig (zie App.tsx): dit
 * scherm werkt net zonder geldige sessie.
 */
export function PortalVerifyPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { setCustomer } = usePortalAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // React 18 Strict Mode (dev) roept effects dubbel op — zonder deze guard zou
  // een eenmalig-bruikbaar token bij de tweede aanroep al "verbruikt" blijken.
  const hasAttempted = useRef(false);

  useEffect(() => {
    if (!token) {
      setErrorMessage('Geen geldig token gevonden in de link.');
      return;
    }
    if (hasAttempted.current) return;
    hasAttempted.current = true;

    portalApi
      .verify(token)
      .then((response) => {
        setCustomer(response.customer);
        window.location.replace('/klantportaal/werkbonnen');
      })
      .catch((error) => {
        setErrorMessage(error instanceof ApiRequestError ? error.message : 'Er ging iets mis. Probeer het opnieuw.');
      });
  }, [token, setCustomer]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-swatt-black px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mb-10 flex flex-col items-center gap-4">
          <div className="rounded-2xl border-2 border-swatt-gold bg-neutral-50 p-8">
            <Logo size="lg" />
          </div>
        </div>

        {errorMessage ? (
          <div className="flex flex-col gap-4">
            <p role="alert" className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
              {errorMessage}
            </p>
            <Link
              to="/klantportaal"
              className="rounded-lg bg-swatt-gold px-4 py-3 text-base font-bold text-swatt-black"
            >
              Nieuwe inloglink aanvragen
            </Link>
          </div>
        ) : (
          <p className="text-neutral-400">Bezig met inloggen...</p>
        )}
      </div>
    </main>
  );
}
