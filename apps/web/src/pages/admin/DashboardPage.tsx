import type { DashboardActiveEmployeeSummary, DashboardTodayResponseBody, WorkOrderStatus } from '@swatt/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/**
 * Klantvraag 13/9/2026 — sectie 19 "Vandaag"-dashboard voor de admin, nooit
 * gebouwd: "wie is er nu actief aan het werk en bij welk project, hoeveel
 * uur is er vandaag al geregistreerd, hoeveel werkbonnen staan er in
 * concept/ondertekend/met syncfout, hoeveel uur staat er klaar voor
 * facturatie... nu moet je daarvoor tussen losse schermen (werkbonnenover-
 * zicht, sync-fouten, facturatie) heen en weer." Puur uitlezen van bestaande
 * data — geen nieuwe backend-logica, zie dashboard.service.ts/routes.ts.
 *
 * Zelfde statuslabels als WorkOrdersOverviewPage.tsx (bewust lokaal
 * gedupliceerd, zoals de rest van deze codebase kleine Nederlandse
 * labelmaps per pagina herhaalt i.p.v. centraliseert).
 */
const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT: 'Concept',
  READY_FOR_SIGNATURE: 'Klaar om te ondertekenen',
  SIGNED: 'Ondertekend',
  SYNC_PENDING: 'Synchronisatie bezig',
  SYNC_FAILED: 'Synchronisatie mislukt',
  READY_FOR_INVOICING: 'Klaar voor facturatie',
  INVOICED: 'Gefactureerd',
};

/** Statussen die op het dashboard als opvallende tegel getoond worden (het voorbeeld uit sectie 19: concept/ondertekend/syncfout) — de overige 4 staan in de compacte badge-rij eronder. */
const HIGHLIGHT_STATUSES: WorkOrderStatus[] = ['DRAFT', 'SIGNED', 'SYNC_FAILED'];

export function DashboardPage() {
  const [data, setData] = useState<DashboardTodayResponseBody | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Live-tikkende klok — zelfde patroon als ProjectTimerPage.tsx (`nowMs` +
  // een 1s-interval), zodat de actieve-medewerkerslijst hieronder elke
  // seconde meetelt zonder een nieuwe API-aanroep per tik.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { from, to } = todayLocalRange();
        const response = await dashboardApi.today(from, to);
        if (!cancelled) {
          setData(response);
          setErrorMessage(null);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon het dashboard niet ophalen.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    // Elke 30s herladen zodat het dashboard actueel blijft zonder handmatige refresh.
    const refreshInterval = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
    };
  }, []);

  const otherStatuses = useMemo(
    () => (Object.keys(STATUS_LABELS) as WorkOrderStatus[]).filter((status) => !HIGHLIGHT_STATUSES.includes(status)),
    [],
  );

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Vandaag</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug naar overzicht
        </Link>
      </header>

      {errorMessage && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div>
      )}

      {isLoading && !data ? (
        <p className="text-sm text-neutral-500">Laden...</p>
      ) : data ? (
        <div className="flex flex-col gap-8">
          {/* Stat-tegels: vandaag geregistreerd + klaar voor facturatie. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-neutral-200 bg-white p-5">
              <p className="text-xs font-medium uppercase tracking-[0.15em] text-neutral-500">Vandaag geregistreerd</p>
              <p className="mt-2 text-3xl font-extrabold tabular-nums tracking-tight">{formatHm(data.todayTotalSeconds)} u</p>
              <p className="mt-1 text-sm text-neutral-500">
                {data.todayEntryCount} {data.todayEntryCount === 1 ? 'tijdregistratie' : 'tijdregistraties'}
              </p>
            </div>
            <Link
              to="/backoffice/facturatie"
              className="rounded-xl border border-swatt-gold/40 bg-swatt-gold/10 p-5 transition hover:border-swatt-gold"
            >
              <p className="text-xs font-medium uppercase tracking-[0.15em] text-swatt-gold-dark">Klaar voor facturatie</p>
              <p className="mt-2 text-3xl font-extrabold tabular-nums tracking-tight">{formatHm(data.invoiceableSeconds)} u</p>
              <p className="mt-1 text-sm text-neutral-600">
                {data.invoiceableWorkOrderCount} {data.invoiceableWorkOrderCount === 1 ? 'werkbon' : 'werkbonnen'} — naar
                Facturatie →
              </p>
            </Link>
          </div>

          {/* Actieve medewerkers. */}
          <section>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.1em] text-neutral-500">
              Actieve medewerkers {data.activeEmployees.length > 0 && `(${data.activeEmployees.length})`}
            </h2>
            {data.activeEmployees.length === 0 ? (
              <p className="rounded-xl border border-dashed border-neutral-300 bg-white px-5 py-6 text-sm text-neutral-500">
                Niemand heeft op dit moment een actieve timer.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {data.activeEmployees.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 bg-white px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{entry.employeeDisplayName}</p>
                      <p className="truncate text-sm text-neutral-500">
                        {entry.projectName
                          ? `${entry.customerName ? `${entry.customerName} — ` : ''}${entry.projectName}`
                          : activityTypeLabel(entry.activityType)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {entry.status === 'PAUSED' && (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                          Gepauzeerd
                        </span>
                      )}
                      <span className="text-lg font-bold tabular-nums">{formatDuration(computeElapsedSeconds(entry, nowMs))}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Werkbonstatussen. */}
          <section>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.1em] text-neutral-500">Werkbonnen</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {HIGHLIGHT_STATUSES.map((status) => (
                <Link
                  key={status}
                  to={status === 'SYNC_FAILED' ? '/backoffice/sync-fouten' : '/backoffice/werkbonnen'}
                  className="rounded-xl border border-neutral-200 bg-white p-5 transition hover:border-swatt-gold"
                >
                  <p className="text-xs font-medium uppercase tracking-[0.15em] text-neutral-500">{STATUS_LABELS[status]}</p>
                  <p className="mt-2 text-3xl font-extrabold tabular-nums tracking-tight">{data.workOrderStatusCounts[status]}</p>
                </Link>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {otherStatuses.map((status) => (
                <Link
                  key={status}
                  to="/backoffice/werkbonnen"
                  className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-600 transition hover:border-swatt-gold"
                >
                  {STATUS_LABELS[status]}: <span className="font-semibold tabular-nums">{data.workOrderStatusCounts[status]}</span>
                </Link>
              ))}
            </div>
            <Link to="/backoffice/werkbonnen" className="mt-3 inline-block text-sm text-swatt-gold-dark underline">
              Volledig werkbonnenoverzicht →
            </Link>
          </section>
        </div>
      ) : null}
    </main>
  );
}

/** Lokale kalenderdag (van middernacht tot middernacht in de tijdzone van de bezoeker) als expliciete ISO-tijdstippen — bewust CLIENT-side berekend, zelfde les als Fase 19 (de planningmodule): een Render-server draait in UTC en zou rond middernacht een andere dag aanwijzen dan de gebruiker in België. */
function todayLocalRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function activityTypeLabel(activityType: string): string {
  switch (activityType) {
    case 'TRAVEL':
      return 'Verplaatsing';
    case 'WAREHOUSE':
      return 'Magazijn';
    case 'ADMIN':
      return 'Administratie';
    default:
      return 'Overige activiteit';
  }
}

/** Zelfde formule als ProjectTimerPage.tsx se `computeElapsedSeconds` / dashboard.service.ts se `computeWorkedSecondsAsOf`. */
function computeElapsedSeconds(entry: DashboardActiveEmployeeSummary, nowMs: number): number {
  const startedMs = new Date(entry.startedAt).getTime();
  if (entry.status === 'RUNNING') {
    return Math.max(0, Math.floor((nowMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  if (entry.status === 'PAUSED' && entry.currentPauseStartedAt) {
    const pauseStartMs = new Date(entry.currentPauseStartedAt).getTime();
    return Math.max(0, Math.floor((pauseStartMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  return 0;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "7:30" — zelfde weergave als InvoicingPage.tsx/de werkbon-PDF. */
function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}
