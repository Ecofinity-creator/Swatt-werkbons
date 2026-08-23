import type { ProjectSyncResponseBody, TeamleaderStatusResponseBody } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { teamleaderApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

const PROJECTS_MODULE_LABELS: Record<string, string> = {
  LEGACY: 'legacy projecten',
  PROJECTS_V2: 'nieuwe projecten (projects-v2)',
};

const STATUS_LABELS: Record<string, string> = {
  CONNECTED: 'Verbonden',
  DISCONNECTED: 'Niet verbonden',
  ERROR: 'Fout',
};

const STATUS_DOTS: Record<string, string> = {
  CONNECTED: '🟢',
  DISCONNECTED: '⚪',
  ERROR: '🔴',
};

/** Mensentaal-versies van de foutcodes die de backend meegeeft via de redirect (zie teamleader.routes.ts). */
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  DENIED: 'De koppeling werd geannuleerd of geweigerd in Teamleader.',
  STATE_MISMATCH:
    'De koppelingspoging kon niet geverifieerd worden (verlopen of ongeldige aanvraag). Probeer opnieuw.',
  MISSING_CODE: 'Teamleader gaf geen geldige autorisatiecode terug. Probeer opnieuw.',
  EXCHANGE_FAILED: 'De koppeling met Teamleader is mislukt. Probeer opnieuw of neem contact op met support.',
  HANDOFF_EXPIRED: 'Deze koppelingspoging is verlopen. Klik hieronder opnieuw op "Verbind met Teamleader".',
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('nl-BE', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Admin-scherm "Teamleader-integratie" (Phase 2 van de roadmap). Bewust nog
 * met dezelfde donkere styling als de Phase 1-Home i.p.v. het lichte
 * backoffice-thema uit Stap 5 van het fundamentendocument — er bestaat nog
 * geen bredere backoffice-schil (sidebar/navigatie); dat komt pas wanneer er
 * meerdere backoffice-schermen tegelijk gebouwd worden (vanaf Phase 3+).
 */
export function TeamleaderSettingsPage() {
  const [status, setStatus] = useState<TeamleaderStatusResponseBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isSyncingProjects, setIsSyncingProjects] = useState(false);
  const [syncResult, setSyncResult] = useState<ProjectSyncResponseBody | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const callbackError = searchParams.get('teamleaderError');
  const justConnected = searchParams.get('teamleaderConnected') === '1';

  const loadStatus = useCallback(async () => {
    try {
      const response = await teamleaderApi.status();
      setStatus(response);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Kon de Teamleader-status niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    // Query-params opruimen zodat een herlaadbeurt de melding niet blijft herhalen.
    if (callbackError || justConnected) {
      const next = new URLSearchParams(searchParams);
      next.delete('teamleaderError');
      next.delete('teamleaderConnected');
      setSearchParams(next, { replace: true });
    }
    // Enkel bij het inladen van de pagina uitvoeren — niet bij elke wijziging van searchParams zelf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    setIsConnecting(true);
    setLoadError(null);
    try {
      // Navigeert bij succes de hele pagina weg (zie teamleaderApi.connect) —
      // isConnecting hoeft dan niet meer teruggezet te worden.
      await teamleaderApi.connect();
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Verbinden met Teamleader is mislukt. Probeer opnieuw.');
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Weet je zeker dat je de Teamleader-koppeling wil verbreken?')) return;
    setIsDisconnecting(true);
    try {
      await teamleaderApi.disconnect();
      await loadStatus();
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Verbreken van de koppeling is mislukt.');
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleSyncProjects = async () => {
    setIsSyncingProjects(true);
    setSyncError(null);
    try {
      const result = await teamleaderApi.syncProjects();
      setSyncResult(result);
    } catch (err) {
      setSyncError(err instanceof ApiRequestError ? err.message : 'Synchroniseren van projecten is mislukt.');
    } finally {
      setIsSyncingProjects(false);
    }
  };

  return (
    <main className="min-h-screen bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Teamleader-integratie</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Instellingen</p>
        </div>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      {justConnected && (
        <p className="mb-4 rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-3 text-sm text-emerald-300">
          Teamleader is succesvol gekoppeld.
        </p>
      )}
      {callbackError && (
        <p className="mb-4 rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {CALLBACK_ERROR_MESSAGES[callbackError] ?? 'Er ging iets mis bij het koppelen met Teamleader.'}
        </p>
      )}
      {loadError && (
        <p className="mb-4 rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {loadError}
        </p>
      )}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <p className="text-sm text-neutral-400">Status</p>
        <p className="mt-1 text-lg font-semibold">
          {status ? `${STATUS_DOTS[status.status] ?? ''} ${STATUS_LABELS[status.status] ?? status.status}` : 'Laden...'}
        </p>

        {status?.status === 'ERROR' && status.lastError && (
          <p className="mt-2 text-sm text-red-300">{status.lastError}</p>
        )}

        {status?.status === 'CONNECTED' && (
          <dl className="mt-4 space-y-1 text-sm text-neutral-400">
            <div className="flex justify-between">
              <dt>Gekoppeld sinds</dt>
              <dd>{formatDateTime(status.connectedAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Token geldig tot</dt>
              <dd>{formatDateTime(status.tokenExpiresAt)}</dd>
            </div>
          </dl>
        )}
      </section>

      {status?.status === 'CONNECTED' && (
        <section className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <p className="text-sm text-neutral-400">Projecten</p>
          <p className="mt-1 text-sm text-neutral-300">
            Haalt klanten en projecten op uit Teamleader zodat medewerkers eraan gekoppeld kunnen worden (zie{' '}
            <Link to="/backoffice/medewerkers" className="underline">
              Medewerkers
            </Link>
            ).
          </p>

          {syncError && <p className="mt-3 text-sm text-red-300">{syncError}</p>}
          {syncResult && (
            <p className="mt-3 text-sm text-emerald-300">
              Klaar — {PROJECTS_MODULE_LABELS[syncResult.module] ?? syncResult.module}: {syncResult.syncedCount}{' '}
              project(en) gesynchroniseerd, {syncResult.archivedCount} gearchiveerd
              {syncResult.skippedWithoutCustomerCount > 0 &&
                `, ${syncResult.skippedWithoutCustomerCount} overgeslagen (geen klant gekoppeld in Teamleader)`}
              .
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleSyncProjects()}
            disabled={isSyncingProjects}
            className="mt-4 rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-200 active:bg-neutral-800 disabled:opacity-50"
          >
            {isSyncingProjects ? 'Bezig met synchroniseren...' : 'Synchroniseer projecten'}
          </button>
        </section>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {status?.status !== 'CONNECTED' ? (
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={isConnecting}
            className="rounded-lg bg-swatt-gold px-4 py-4 text-center text-base font-semibold text-swatt-black active:opacity-80 disabled:opacity-50"
          >
            {isConnecting ? 'Bezig...' : 'Verbind met Teamleader'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={isDisconnecting}
            className="rounded-lg border border-neutral-700 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-900 disabled:opacity-50"
          >
            {isDisconnecting ? 'Bezig...' : 'Verbinding verbreken'}
          </button>
        )}
      </div>
    </main>
  );
}
