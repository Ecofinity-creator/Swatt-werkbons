import { AUDIT_LOG_ACTION_LABELS, type AdminUserSummary, type AuditLogEntrySummary } from '@swatt/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { auditLogApi, type AuditLogFilters, usersApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';
import { DownloadIcon, SearchIcon } from '../../components/icons';

/**
 * Backoffice-scherm "Auditlog" (op vraag, 3/9/2026: "om bij een geschil te
 * zien wie iets wanneer gewijzigd heeft" — sectie 23/26 uit de oorspronkelijke
 * projectbrief). Uitgebreid 13/9/2026 op klantvraag: "een doorzoekbare
 * auditlog-UI (de data wordt al gelogd, er is alleen geen scherm) is dan
 * weer sterk richting bedrijven die met aanbestedingen of
 * verzekeringsvereisten werken" — vandaar de Actie/Door-filters, de vrije
 * zoekbalk, "Meer laden" i.p.v. een harde afkap op 100 rijen, en de
 * Excel-export (met een apart infoblad met de toegepaste filters, zodat het
 * bruikbaar is als bewijsstuk). ADMIN-only, zelfde gevoeligheidsniveau als
 * Facturatie/Uren-export.
 *
 * Toont enkel de acties die AuditLogService instrumenteert (zie de
 * toelichting bij AuditLog in schema.prisma — een eerste, gerichte selectie
 * van financiële/status-wijzigingen, niet elke mogelijke actie in de app).
 */
const ENTITY_TYPE_OPTIONS = [
  { value: '', label: 'Alle types' },
  { value: 'TimeEntry', label: 'Tijdregistratie' },
  { value: 'WorkOrder', label: 'Werkbon' },
  { value: 'WeeklyApproval', label: 'Weekgoedkeuring' },
  { value: 'PayrollBatch', label: 'Personeelsuitbetaling' },
  { value: 'InvoiceBatch', label: 'Facturatiebatch' },
  { value: 'Employee', label: 'Medewerker (uren-export)' },
  { value: 'User', label: 'Gebruiker' },
  { value: 'AuditLog', label: 'Auditlog zelf (export)' },
];

const ACTION_OPTIONS = [{ value: '', label: 'Alle acties' }, ...Object.entries(AUDIT_LOG_ACTION_LABELS)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label, 'nl-BE'))];

const PAGE_SIZE = 100;

/** Routes die een detailpagina hebben voor dit entiteitstype — zie App.tsx. Andere types tonen enkel de ruwe ID (geen gok naar een niet-bestaande route). */
function entityDetailPath(entityType: string, entityId: string): string | null {
  if (entityType === 'WorkOrder') return `/werkbonnen/${entityId}`;
  if (entityType === 'User') return `/backoffice/medewerkers/${entityId}`;
  return null;
}

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntrySummary[] | null>(null);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const structuredFilters = useMemo<AuditLogFilters>(
    () => ({
      entityType: entityType || undefined,
      action: action || undefined,
      actorUserId: actorUserId || undefined,
      from: fromDate ? new Date(fromDate).toISOString() : undefined,
      to: toDate ? new Date(`${toDate}T23:59:59`).toISOString() : undefined,
    }),
    [entityType, action, actorUserId, fromDate, toDate],
  );

  const load = useCallback(async (filters: AuditLogFilters) => {
    try {
      const response = await auditLogApi.list({ ...filters, limit: PAGE_SIZE });
      setEntries(response.entries);
      setHasMore(response.entries.length === PAGE_SIZE);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de auditlog niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load(structuredFilters);
  }, [structuredFilters, load]);

  useEffect(() => {
    usersApi
      .list()
      .then((response) => setUsers(response.users))
      .catch(() => {
        // Enkel nodig voor het "Door"-filter — een falende ophaling mag de rest van het scherm niet blokkeren.
      });
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (!entries || entries.length === 0) return;
    setIsLoadingMore(true);
    try {
      const oldestLoaded = entries[entries.length - 1];
      const response = await auditLogApi.list({ ...structuredFilters, before: oldestLoaded?.createdAt, limit: PAGE_SIZE });
      setEntries((prev) => [...(prev ?? []), ...response.entries]);
      setHasMore(response.entries.length === PAGE_SIZE);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon niet meer laden.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [entries, structuredFilters]);

  const visibleEntries = useMemo(() => {
    if (!entries) return entries;
    const term = searchTerm.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) => {
      const haystack = [
        AUDIT_LOG_ACTION_LABELS[entry.action] ?? entry.action,
        entry.action,
        entry.actorDisplayName ?? 'Systeem',
        entry.entityType,
        entry.entityId,
        entry.metadata ? JSON.stringify(entry.metadata) : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [entries, searchTerm]);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => (a.employee?.displayName ?? a.email).localeCompare(b.employee?.displayName ?? b.email, 'nl-BE')),
    [users],
  );

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Auditlog</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm font-semibold text-swatt-gold-dark underline">
          Terug naar overzicht
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="text-sm text-neutral-600">
          Type
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            {ENTITY_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-neutral-600">
          Actie
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="mt-1 block max-w-[16rem] rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-neutral-600">
          Door
          <select
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            className="mt-1 block max-w-[14rem] rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            <option value="">Alle gebruikers</option>
            {sortedUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.employee?.displayName ?? u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-neutral-600">
          Van
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          />
        </label>
        <label className="text-sm text-neutral-600">
          Tot
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          />
        </label>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <label className="relative flex-1 min-w-[16rem]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Zoeken in geladen resultaten — actie, medewerker, entiteit-ID, details..."
            className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-swatt-gold"
          />
        </label>
        <a
          href={auditLogApi.exportUrl(structuredFilters)}
          download
          className="flex shrink-0 items-center gap-2 rounded-lg bg-swatt-gold-dark px-4 py-2 text-sm font-semibold text-white"
        >
          <DownloadIcon className="h-4 w-4" />
          Exporteren naar Excel
        </a>
      </div>
      <p className="-mt-3 mb-6 text-xs text-neutral-500">
        De export volgt de filters Type/Actie/Door/Van/Tot hierboven (de volledige, chronologische set — niet enkel de al-geladen
        pagina) — niet de vrije zoekbalk, die enkel binnen de al-geladen resultaten zoekt.
      </p>

      {errorMessage && <p className="mb-4 text-sm text-red-700">{errorMessage}</p>}

      {visibleEntries && visibleEntries.length === 0 && (
        <p className="text-sm text-neutral-500">Geen resultaten voor deze filters.</p>
      )}

      {visibleEntries && visibleEntries.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3">Datum/tijd</th>
                  <th className="px-4 py-3">Actie</th>
                  <th className="px-4 py-3">Door</th>
                  <th className="px-4 py-3">Entiteit</th>
                  <th className="px-4 py-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {visibleEntries.map((entry) => {
                  const detailPath = entityDetailPath(entry.entityType, entry.entityId);
                  return (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-neutral-500">
                        {new Date(entry.createdAt).toLocaleString('nl-BE')}
                      </td>
                      <td className="px-4 py-3 font-medium">{AUDIT_LOG_ACTION_LABELS[entry.action] ?? entry.action}</td>
                      <td className="px-4 py-3 text-neutral-600">{entry.actorDisplayName ?? 'Systeem'}</td>
                      <td className="px-4 py-3 text-neutral-500">
                        <span className="text-xs uppercase tracking-wide text-neutral-400">{entry.entityType}</span>
                        <br />
                        {detailPath ? (
                          <Link to={detailPath} className="font-mono text-xs text-swatt-gold-dark underline">
                            {entry.entityId.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="font-mono text-xs" title={entry.entityId}>
                            {entry.entityId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">
                        <MetadataView metadata={entry.metadata} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasMore && !searchTerm && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => void handleLoadMore()}
                disabled={isLoadingMore}
                className="rounded-lg border border-neutral-300 bg-white px-5 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
              >
                {isLoadingMore ? 'Laden...' : 'Meer laden'}
              </button>
            </div>
          )}
          {hasMore && searchTerm && (
            <p className="mt-4 text-center text-xs text-neutral-500">
              Er zijn nog meer rijen buiten de al-geladen pagina — wis de zoekterm om "Meer laden" te gebruiken.
            </p>
          )}
        </>
      )}
    </main>
  );
}

/** Leesbare weergave van de vrije metadata-JSON: key/value-lijst i.p.v. rauwe JSON, camelCase omgezet naar spaties, booleans als Ja/Nee. */
function MetadataView({ metadata }: { metadata: Record<string, unknown> | null }) {
  if (!metadata || Object.keys(metadata).length === 0) return <>—</>;
  return (
    <dl className="flex flex-col gap-0.5">
      {Object.entries(metadata).map(([key, value]) => (
        <div key={key} className="flex gap-1">
          <dt className="text-neutral-400">{humanizeKey(key)}:</dt>
          <dd className="text-neutral-600">{formatMetadataValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nee';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
