import type { PayableEmployeeSummary, PayrollBatchSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { payrollApi } from '../../api/client';
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

/** "€ 65,00" — of "geen tarief" wanneer de medewerker nog geen uurtarief heeft (zie UserDetailPage). */
function formatEuroCents(cents: number | null): string {
  if (cents === null) return 'geen tarief ingesteld';
  return `€ ${(cents / 100).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "7,50u" — uren worden hier als decimaal getal bijgehouden (RateCalculationService), niet als seconden. */
function formatHours(hours: number): string {
  return `${hours.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}u`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Backoffice-scherm "Personeelsuitbetaling" (Phase 12, deel E) — maandoverzicht
 * per medewerker met exact dezelfde rekenlogica als de klantfactuur
 * (RateCalculationService, zie teamleader-invoice.service.ts), maar bewust
 * losgekoppeld van Facturatie/Project.invoicingEnabled: een medewerker wordt
 * hier uitbetaald voor élke ondertekende uur, ook op een nacalculatie-project
 * zonder klantfactuur (zie PayrollService).
 *
 * ADMIN-only, zelfde reden als Facturatie/Uren-export (sectie 4 — boekhouding,
 * en business rule 11: bedragen die nooit voor de medewerker zelf zichtbaar
 * mogen zijn).
 */
export function PayrollPage() {
  const [periodLabel, setPeriodLabel] = useState(currentPeriodLabel());
  const [employees, setEmployees] = useState<PayableEmployeeSummary[] | null>(null);
  const [batches, setBatches] = useState<PayrollBatchSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [closingEmployeeId, setClosingEmployeeId] = useState<string | null>(null);
  const [closeErrorByEmployeeId, setCloseErrorByEmployeeId] = useState<Record<string, string>>({});
  const [removingBatchId, setRemovingBatchId] = useState<string | null>(null);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);

  const load = useCallback(async (period: string) => {
    try {
      const [payableResponse, batchesResponse] = await Promise.all([
        payrollApi.listPayable(period),
        payrollApi.list({ periodLabel: period }),
      ]);
      setEmployees(payableResponse.employees);
      setBatches(batchesResponse.batches);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Kon het personeelsuitbetaling-overzicht niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load(periodLabel);
  }, [load, periodLabel]);

  async function handleClose(employee: PayableEmployeeSummary) {
    setClosingEmployeeId(employee.employeeId);
    setCloseErrorByEmployeeId((previous) => {
      const next = { ...previous };
      delete next[employee.employeeId];
      return next;
    });
    try {
      await payrollApi.createBatch({ employeeId: employee.employeeId, periodLabel });
      await load(periodLabel);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Afsluiten voor deze medewerker is mislukt.';
      setCloseErrorByEmployeeId((previous) => ({ ...previous, [employee.employeeId]: message }));
    } finally {
      setClosingEmployeeId(null);
    }
  }

  async function handleRemoveBatch(batchId: string) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Deze personeelsuitbetaling verwijderen? De uren komen dan weer beschikbaar om af te sluiten.')) return;
    setRemovingBatchId(batchId);
    try {
      await payrollApi.removeBatch(batchId);
      await load(periodLabel);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Verwijderen van de personeelsuitbetaling is mislukt.');
    } finally {
      setRemovingBatchId(null);
    }
  }

  // Al afgesloten medewerkers (deze periode) uit het "nog te betalen"-overzicht
  // weren zou een tweede afsluiting technisch niet blokkeren (PayrollService
  // vindt dan gewoon geen betaalbare uren meer, zie sessie-overzicht), maar is
  // wel verwarrend op het scherm — dus expliciet uitsluiten op basis van de
  // batches die al bestaan voor deze periode.
  const closedEmployeeIds = new Set((batches ?? []).map((batch) => batch.employeeId));
  const openEmployees = (employees ?? []).filter((employee) => !closedEmployeeIds.has(employee.employeeId));

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Personeelsuitbetaling</h1>
          <p className="text-sm text-neutral-500">
            Uren, overuren, ploegen- en nachtwerk per medewerker — bedrag exact zoals aan de klant aangerekend, ook
            voor nacalculatie-projecten zonder klantfactuur.
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

      {loadError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </p>
      )}

      <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Nog af te sluiten ({openEmployees.length})
        </h2>

        {employees === null && !loadError && <p className="text-sm text-neutral-500">Laden...</p>}
        {employees !== null && openEmployees.length === 0 && (
          <p className="text-sm text-neutral-500">
            Geen openstaande, betaalbare uren voor {formatPeriodLabel(periodLabel)}.
          </p>
        )}

        {openEmployees.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4">Medewerker</th>
                  <th className="py-2 pr-4">Normaal</th>
                  <th className="py-2 pr-4">Overuren</th>
                  <th className="py-2 pr-4">Ploegenwerk</th>
                  <th className="py-2 pr-4">Nachtwerk</th>
                  <th className="py-2 pr-4">Totaal</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {openEmployees.map((employee) => (
                  <tr key={employee.employeeId} className="border-b border-neutral-100 last:border-0">
                    <td className="py-3 pr-4 font-medium">{employee.displayName}</td>
                    <td className="py-3 pr-4 text-neutral-600">{formatHours(employee.normalHours)}</td>
                    <td className="py-3 pr-4 text-neutral-600">{formatHours(employee.overtimeHours)}</td>
                    <td className="py-3 pr-4 text-neutral-600">{formatHours(employee.shiftHours)}</td>
                    <td className="py-3 pr-4 text-neutral-600">{formatHours(employee.nightHours)}</td>
                    <td className="py-3 pr-4 font-medium">{formatEuroCents(employee.totalAmountCents)}</td>
                    <td className="py-3">
                      <button
                        type="button"
                        disabled={employee.totalAmountCents === null || closingEmployeeId === employee.employeeId}
                        onClick={() => void handleClose(employee)}
                        title={employee.totalAmountCents === null ? 'Vul eerst een uurtarief in bij Medewerkers' : undefined}
                        className="rounded-lg bg-swatt-gold-dark px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {closingEmployeeId === employee.employeeId ? 'Bezig...' : 'Afsluiten'}
                      </button>
                      {closeErrorByEmployeeId[employee.employeeId] && (
                        <p className="mt-1 text-xs text-red-700">{closeErrorByEmployeeId[employee.employeeId]}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Afgesloten ({(batches ?? []).length})
        </h2>

        {batches !== null && batches.length === 0 && (
          <p className="text-sm text-neutral-500">Nog geen personeelsuitbetalingen afgesloten voor {formatPeriodLabel(periodLabel)}.</p>
        )}

        {batches && batches.length > 0 && (
          <ul className="divide-y divide-neutral-100">
            {batches.map((batch) => (
              <li key={batch.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <button
                      type="button"
                      onClick={() => setExpandedBatchId((current) => (current === batch.id ? null : batch.id))}
                      className="text-left text-sm font-medium underline decoration-dotted"
                    >
                      {batch.employeeDisplayName}
                    </button>
                    <span className="ml-2 text-sm text-neutral-500">
                      {formatEuroCents(batch.totalAmountCents)} · afgesloten op {formatDate(batch.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/admin/payroll/batches/${batch.id}/excel`}
                      download
                      className="rounded-lg bg-swatt-gold-dark px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Excel
                    </a>
                    <a
                      href={`/admin/payroll/batches/${batch.id}/pdf`}
                      download
                      className="rounded-lg border border-swatt-gold-dark px-3 py-1.5 text-xs font-semibold text-swatt-gold-dark"
                    >
                      PDF
                    </a>
                    {batch.status === 'DRAFT' && (
                      <button
                        type="button"
                        disabled={removingBatchId === batch.id}
                        onClick={() => void handleRemoveBatch(batch.id)}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                      >
                        {removingBatchId === batch.id ? 'Bezig...' : 'Verwijderen'}
                      </button>
                    )}
                  </div>
                </div>

                {expandedBatchId === batch.id && (
                  <table className="mt-3 w-full text-left text-xs text-neutral-600">
                    <thead>
                      <tr className="border-b border-neutral-100 uppercase tracking-wide">
                        <th className="py-1.5 pr-3">Project</th>
                        <th className="py-1.5 pr-3">Normaal</th>
                        <th className="py-1.5 pr-3">Overuren</th>
                        <th className="py-1.5 pr-3">Toeslag</th>
                        <th className="py-1.5 pr-3">Bedrag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.lines.map((line) => (
                        <tr key={line.id} className="border-b border-neutral-50 last:border-0">
                          <td className="py-1.5 pr-3">{line.projectName}</td>
                          <td className="py-1.5 pr-3">{formatHours(line.normalHours)}</td>
                          <td className="py-1.5 pr-3">{formatHours(line.overtimeHours)}</td>
                          <td className="py-1.5 pr-3">
                            {line.premiumType === 'NONE' ? '—' : line.premiumType === 'SHIFT_WORK' ? 'Ploegenwerk' : 'Nachtwerk'}
                          </td>
                          <td className="py-1.5 pr-3">{formatEuroCents(line.amountCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
