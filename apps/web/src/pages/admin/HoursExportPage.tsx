import type { HoursExportEmployeeSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hoursExportApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

function currentPeriodLabel(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatPeriodLabel(periodLabel: string): string {
  const [year, month] = periodLabel.split('-');
  if (!year || !month) return periodLabel;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
}

/** "7:30" — zelfde weergave als InvoicingPage.tsx/de werkbon-PDF. */
function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Backoffice-scherm "Uren-export" — werknemer vs. onderaannemer
 * (backlog-item 30/8, zie claude/projectoverdracht-samenvatting_2.md sectie
 * 3.3). Dezelfde onderliggende urendata als Facturatie, maar hier bewust
 * "los van de facturatie-toggle": elke medewerker/onderaannemer die deze
 * periode ondertekende uren heeft, staat hier — ongeacht of de bijhorende
 * werkbon al lokaal gefactureerd is.
 *
 * ADMIN-only, zelfde reden als Facturatie (sectie 4).
 */
export function HoursExportPage() {
  const [periodLabel, setPeriodLabel] = useState(currentPeriodLabel());
  const [employees, setEmployees] = useState<HoursExportEmployeeSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async (period: string) => {
    setErrorMessage(null);
    try {
      const response = await hoursExportApi.overview(period);
      setEmployees(response.employees);
    } catch (err) {
      setEmployees(null);
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon het urenoverzicht niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load(periodLabel);
  }, [periodLabel, load]);

  const werknemers = employees?.filter((e) => e.employmentType === 'EMPLOYEE') ?? [];
  const onderaannemers = employees?.filter((e) => e.employmentType === 'SUBCONTRACTOR') ?? [];

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Uren-export</h1>
          <p className="text-sm text-neutral-500">
            Werknemer → Excel-urenexport voor eigen loonverwerking. Onderaannemer → apart
            totalisatie-met-detail-document per periode, om door te sturen.
          </p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug naar overzicht
        </Link>
      </header>

      <div className="mb-6 flex items-center gap-3">
        <label className="text-sm text-neutral-600">
          Periode
          <input
            type="month"
            value={periodLabel}
            onChange={(e) => setPeriodLabel(e.target.value)}
            className="ml-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          />
        </label>
        <span className="text-sm font-medium text-swatt-gold-dark">{formatPeriodLabel(periodLabel)}</span>
      </div>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Werknemers ({werknemers.length})
          </h2>
          {werknemers.length > 0 && (
            <a
              href={`/admin/hours-export/employees/excel?period=${encodeURIComponent(periodLabel)}`}
              download
              className="rounded-lg bg-swatt-gold-dark px-4 py-2 text-sm font-semibold text-white"
            >
              Download Excel (alle werknemers)
            </a>
          )}
        </div>
        {employees === null && !errorMessage && <p className="text-sm text-neutral-500">Laden...</p>}
        {employees !== null && werknemers.length === 0 && (
          <p className="text-sm text-neutral-500">Geen ondertekende uren voor werknemers deze periode.</p>
        )}
        {werknemers.length > 0 && (
          <ul className="divide-y divide-neutral-100">
            {werknemers.map((employee) => (
              <li key={employee.employeeId} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">{employee.displayName}</span>
                <span className="text-neutral-500">
                  {formatHm(employee.totalSeconds)} u · {employee.workOrderCount} werkbon(nen)
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Onderaannemers ({onderaannemers.length})
        </h2>
        {employees !== null && onderaannemers.length === 0 && (
          <p className="text-sm text-neutral-500">Geen ondertekende uren voor onderaannemers deze periode.</p>
        )}
        {onderaannemers.length > 0 && (
          <ul className="divide-y divide-neutral-100">
            {onderaannemers.map((employee) => (
              <li key={employee.employeeId} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <span className="font-medium">{employee.displayName}</span>
                  <span className="ml-2 text-neutral-500">
                    {formatHm(employee.totalSeconds)} u · {employee.workOrderCount} werkbon(nen)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`/admin/hours-export/subcontractors/${employee.employeeId}/excel?period=${encodeURIComponent(periodLabel)}`}
                    download
                    className="rounded-lg bg-swatt-gold-dark px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Download Excel
                  </a>
                  <a
                    href={`/admin/hours-export/subcontractors/${employee.employeeId}/pdf?period=${encodeURIComponent(periodLabel)}`}
                    download
                    className="rounded-lg border border-swatt-gold-dark px-3 py-1.5 text-xs font-semibold text-swatt-gold-dark"
                  >
                    Download PDF
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
