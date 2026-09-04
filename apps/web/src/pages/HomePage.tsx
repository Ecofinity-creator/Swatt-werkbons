import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { publicBrandingApi } from '../api/client';
import { ApiRequestError, useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { ROLE_LABELS } from '../constants';

/**
 * Placeholder-Home voor Phase 1 — bewijst dat login/sessie/RBAC werken.
 * Vanaf Phase 3 (projects sync) komen hier de echte tabs
 * "Vandaag / Recent / Mijn projecten / Zoeken" (zie Stap 5.1 in het fundamentendocument).
 */
export function HomePage() {
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  // Sectie 21/33 — klantlogo (Bedrijfsgegevens) i.p.v. de eerder generieke
  // "Technical Support Team"-tekst, zelfde publieke route als LoginPage.tsx
  // (werkt voor élke rol, niet enkel ADMIN — company-settings.routes.ts zelf
  // blijft ADMIN-only).
  const [branding, setBranding] = useState<{ companyName: string; logoDataUrl: string | null } | null>(null);

  useEffect(() => {
    publicBrandingApi
      .get()
      .then(setBranding)
      .catch(() => setBranding(null));
  }, []);

  if (!user) return null;

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (err) {
      // Zonder deze afhandeling deed de knop bij een mislukte/trage aanroep
      // (bv. Render's gratis instance die na inactiviteit ~50s nodig heeft om
      // op te starten) ogenschijnlijk niets — geen foutmelding, geen laadstatus.
      setLogoutError(err instanceof ApiRequestError ? err.message : 'Uitloggen is mislukt. Probeer opnieuw.');
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex flex-col items-center gap-3">
        {/* Volledige lockup (icoon + "UURIVO"-woordmerk) zoals op het loginscherm,
            i.p.v. enkel het compacte icoon — zelfde goudomrande lichte kaart
            nodig voor zichtbaarheid (donkere tekst/pictogram op transparante
            achtergrond versmelt anders met bg-swatt-black, zie LoginPage.tsx). */}
        <div className="rounded-xl border-2 border-swatt-gold bg-neutral-50 p-4">
          <Logo size="lg" className="w-40" />
        </div>
        {branding?.logoDataUrl && (
          <img src={branding.logoDataUrl} alt={branding.companyName} className="h-10 w-auto object-contain" />
        )}
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <p className="text-sm text-neutral-400">Ingelogd als</p>
        <p className="mt-1 text-lg font-semibold">
          {user.employee?.displayName ?? user.email}
        </p>
        <p className="text-sm text-swatt-gold">{ROLE_LABELS[user.role] ?? user.role}</p>
      </section>

      <Link
        to="/mijn-projecten"
        className="mt-4 rounded-lg bg-swatt-gold px-4 py-4 text-center text-base font-semibold text-swatt-black active:opacity-80"
      >
        Mijn projecten
      </Link>

      <Link
        to="/mijn-werkbonnen"
        className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
      >
        Mijn werkbonnen
      </Link>

      <Link
        to="/app-toegang"
        className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
      >
        App op smartphone (QR-code)
      </Link>

      {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <Link
          to="/backoffice/medewerkers"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Medewerkers
        </Link>
      )}

      {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <Link
          to="/backoffice/projecten"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Projecten
        </Link>
      )}

      {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <Link
          to="/backoffice/sync-fouten"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Synchronisatiefouten
        </Link>
      )}

      {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <Link
          to="/backoffice/werkbonnen"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Werkbonnenoverzicht
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/backoffice/facturatie"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Facturatie
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/backoffice/uren-export"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Uren-export
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/backoffice/personeelsuitbetaling"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Personeelsuitbetaling
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/backoffice/auditlog"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Auditlog
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/instellingen/teamleader"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Teamleader-integratie
        </Link>
      )}

      {user.role === 'ADMIN' && (
        <Link
          to="/instellingen/bedrijf"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Bedrijfsgegevens
        </Link>
      )}

      {logoutError && (
        <p role="alert" className="mt-6 rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
          {logoutError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={isLoggingOut}
        className="mt-auto rounded-lg border border-neutral-700 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-900 disabled:opacity-50"
      >
        {isLoggingOut ? 'Bezig met uitloggen...' : 'Uitloggen'}
      </button>
    </main>
  );
}
