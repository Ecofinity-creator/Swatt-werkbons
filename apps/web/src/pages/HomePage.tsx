import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABELS } from '../constants';

/**
 * Placeholder-Home voor Phase 1 — bewijst dat login/sessie/RBAC werken.
 * Vanaf Phase 3 (projects sync) komen hier de echte tabs
 * "Vandaag / Recent / Mijn projecten / Zoeken" (zie Stap 5.1 in het fundamentendocument).
 */
export function HomePage() {
  const { user, logout } = useAuth();

  if (!user) return null;

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8">
        <h1 className="text-2xl font-extrabold tracking-tight">SWATT</h1>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">
          Technical Support Team
        </p>
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

      {user.role === 'ADMIN' && (
        <Link
          to="/instellingen/teamleader"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-center text-base font-semibold text-neutral-200 active:bg-neutral-800"
        >
          Teamleader-integratie
        </Link>
      )}

      <button
        type="button"
        onClick={() => void logout()}
        className="mt-auto rounded-lg border border-neutral-700 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-900"
      >
        Uitloggen
      </button>
    </main>
  );
}
