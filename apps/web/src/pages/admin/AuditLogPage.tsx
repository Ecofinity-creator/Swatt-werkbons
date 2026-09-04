import type { AuditLogEntrySummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { auditLogApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/**
 * Backoffice-scherm "Auditlog" (op vraag, 3/9/2026: "om bij een geschil te
 * zien wie iets wanneer gewijzigd heeft" — sectie 23/26 uit de oorspronkelijke
 * projectbrief). ADMIN-only, zelfde gevoeligheidsniveau als Facturatie/Uren-
 * export. Toont enkel de acties die AuditLogService instrumenteert (zie de
 * toelichting bij AuditLog in schema.prisma — een eerste, gerichte selectie
 * van financiële/status-wijzigingen, niet elke mogelijke actie in de app).
 */
const ACTION_LABELS: Record<string, string> = {
  TIME_ENTRY_CORRECTED: 'Tijd manueel gecorrigeerd',
  WORK_ORDER_SIGNED: 'Werkbon ondertekend',
  WORK_ORDER_SENT_TO_CUSTOMER: 'Werkbon-PDF naar klant gestuurd',
  WORK_ORDER_REMINDER_SENT: 'Herinnering verstuurd',
  WEEKLY_APPROVAL_SIGNED: 'Week ondertekend',
  WEEKLY_APPROVAL_REOPENED: 'Week heropend',
  PAYROLL_BATCH_CREATED: 'Personeelsuitbetaling aangemaakt',
  PAYROLL_BATCH_REMOVED: 'Personeelsuitbetaling verwijderd',
  INVOICE_BATCH_CREATED: 'Facturatiebatch aangemaakt',
  INVOICE_BATCH_REMOVED: 'Facturatiebatch verwijderd',
  INVOICE_BATCH_TEAMLEADER_DRAFT_CREATED: 'Conceptfactuur aangemaakt in Teamleader',
  HOURS_EXPORT_MARKED_EXPORTED: 'Uren als geëxporteerd gemarkeerd',
  USER_CREATED: 'Gebruiker aangemaakt',
  USER_DEACTIVATED: 'Gebruiker gedeactiveerd',
  USER_ACTIVATED: 'Gebruiker geactiveerd',
  USER_ROLE_CHANGED: 'Rol gewijzigd',
  USER_DELETED: 'Gebruiker verwijderd',
};

const ENTITY_TYPE_OPTIONS = [
  { value: '', label: 'Alle types' },
  { value: 'TimeEntry', label: 'Tijdregistratie' },
  { value: 'WorkOrder', label: 'Werkbon' },
  { value: 'WeeklyApproval', label: 'Weekgoedkeuring' },
  { value: 'PayrollBatch', label: 'Personeelsuitbetaling' },
  { value: 'InvoiceBatch', label: 'Facturatiebatch' },
  { value: 'Employee', label: 'Medewerker (uren-export)' },
  { value: 'User', label: 'Gebruiker' },
];

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntrySummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [entityType, setEntityType] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = useCallback(async (filters: { entityType: string; from: string; to: string }) => {
    try {
      const response = await auditLogApi.list({
        entityType: filters.entityType || undefined,
        from: filters.from ? new Date(filters.from).toISOString() : undefined,
        to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
      });
      setEntries(response.entries);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de auditlog niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load({ entityType, from: fromDate, to: toDate });
  }, [entityType, fromDate, toDate, load]);

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Auditlog</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm font-semibold text-swatt-gold-dark underline">
          Terug naar overzicht
        </Link>
      </header>

      <div className="mb-6 flex flex-wrap items-end gap-4">
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

      {errorMessage && <p className="mb-4 text-sm text-red-700">{errorMessage}</p>}

      {entries && entries.length === 0 && <p className="text-sm text-neutral-500">Geen resultaten voor deze filters.</p>}

      {entries && entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Datum/tijd</th>
                <th className="px-4 py-3">Actie</th>
                <th className="px-4 py-3">Door</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-500">
                    {new Date(entry.createdAt).toLocaleString('nl-BE')}
                  </td>
                  <td className="px-4 py-3 font-medium">{ACTION_LABELS[entry.action] ?? entry.action}</td>
                  <td className="px-4 py-3 text-neutral-600">{entry.actorDisplayName ?? 'Systeem'}</td>
                  <td className="px-4 py-3 text-xs text-neutral-500">{formatMetadata(entry.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/** Eenvoudige, leesbare weergave van de vrije metadata-JSON — geen poging tot mooie opmaak per actietype, enkel key: value. */
function formatMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '—';
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
}
