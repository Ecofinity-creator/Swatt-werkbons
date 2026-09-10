import type {
  InvoiceBatchLineSummary,
  InvoiceBatchProjectRateSummary,
  InvoiceBatchSummary,
  InvoiceableWorkOrderSummary,
} from '@swatt/shared-types';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoiceBatchesApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/** "€ 65,00" — of "niet ingesteld" wanneer nog geen uurtarief gekozen is. */
function formatEuroCents(cents: number | null): string {
  if (cents === null) return 'niet ingesteld';
  return `€ ${(cents / 100).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Maak conceptfactuur in Teamleader" mag pas als elk project op deze batch een (standaard- of eenmalig) tarief heeft. */
function allProjectRatesSet(batch: InvoiceBatchSummary): boolean {
  return batch.projectRates.every((rate) => rate.effectiveHourlyRateCents !== null);
}

function currentPeriodLabel(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** "7:30" — zelfde weergave als de werkbon-PDF (sectie 8's voorbeeld). */
function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatPeriodLabel(periodLabel: string): string {
  const [year, month] = periodLabel.split('-');
  if (!year || !month) return periodLabel;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
}

/** "2,17" i.p.v. "niet ingesteld" — voor het km-invoerveld hieronder (leeg = geen km-vergoeding). */
function formatEuroInputValue(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

/**
 * Klantvraag 10/9/2026 — "H:MM"-invoerveld voor de uren-correctie, bv. "2:17".
 * `null` bij een ongeldige invoer (i.p.v. gooien) zodat de aanroeper zelf een
 * duidelijke Nederlandstalige foutmelding kan tonen (sectie 27).
 */
function parseHmInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = /^(\d{1,3}):([0-5]?\d)$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 3600 + minutes * 60;
}

/**
 * Zelfde formule als teamleader-invoice.service.ts's/invoice-batch-pdf-
 * bundle.service.ts's isoWeekKeyOf (ISO-8601, maandag als eerste dag) —
 * hier enkel gebruikt om de "Download per week"-links hieronder te
 * groeperen/labelen; de backend berekent deze sleutel zelf onafhankelijk
 * opnieuw bij de effectieve bundeling, dus een eventuele frontend/backend-
 * afwijking kan hoogstens een verkeerd label opleveren, nooit een verkeerde
 * bundel-inhoud.
 */
function isoWeekKeyOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (d.getUTCDay() + 6) % 7; // maandag = 0
  d.setUTCDate(d.getUTCDate() - dayNumber + 3); // donderdag van deze ISO-week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNumber + 3);
  const weekNumber = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}

interface WeekPdfGroup {
  weekKey: string;
  weekNumber: number;
  lineCount: number;
}

/** Groepeert de werkbonnen van een batch per ISO-week van hun ondertekeningsdatum — voor de "Download per week"-links (klantvraag 10/9/2026). */
function weekPdfGroupsForBatch(batch: InvoiceBatchSummary): WeekPdfGroup[] {
  const counts = new Map<string, number>();
  for (const line of batch.lines) {
    if (!line.signedAt) continue;
    const weekKey = isoWeekKeyOf(new Date(line.signedAt));
    counts.set(weekKey, (counts.get(weekKey) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([weekKey, lineCount]) => ({ weekKey, weekNumber: Number(weekKey.split('-W')[1]), lineCount }))
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey));
}

interface ProjectGroup {
  customerId: string;
  customerName: string;
  projectId: string;
  projectName: string;
  workOrders: InvoiceableWorkOrderSummary[];
  totalSeconds: number;
}

function groupByCustomerAndProject(workOrders: InvoiceableWorkOrderSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const workOrder of workOrders) {
    const key = `${workOrder.customer.id}::${workOrder.project.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.workOrders.push(workOrder);
      existing.totalSeconds += workOrder.invoiceableSeconds;
    } else {
      groups.set(key, {
        customerId: workOrder.customer.id,
        customerName: workOrder.customer.name,
        projectId: workOrder.project.id,
        projectName: workOrder.project.name,
        workOrders: [workOrder],
        totalSeconds: workOrder.invoiceableSeconds,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.customerName.localeCompare(b.customerName) || a.projectName.localeCompare(b.projectName));
}

/**
 * Backoffice-scherm "Facturatie" (sectie 17/29 — MVP1's "basis
 * facturatieoverzicht"). Sinds Phase 10b ook de "Maak conceptfactuur in
 * Teamleader"-knop op elke DRAFT-batch. Werkbonnen selecteren en
 * "voorbereiden voor facturatie" blijft de eerste, lokale stap
 * (InvoiceBatch/InvoiceBatchLine); de Teamleader-stap hieronder is een losse,
 * latere actie op een reeds voorbereide batch — zie TeamleaderInvoiceService
 * voor de volledige toelichting.
 *
 * Klantvraag 10/9/2026: tarief per PROJECT i.p.v. per medewerker. Elke batch
 * toont hier per betrokken project het uurtarief waarmee de conceptfactuur
 * geprijsd wordt (standaardtarief uit "Projecten", of — ontbreekt dat nog —
 * een eenmalige override die hier, vlak vóór het aanmaken van de factuur,
 * ingevuld kan worden). "Maak conceptfactuur in Teamleader" blijft
 * uitgeschakeld zolang niet elk project een tarief heeft.
 */
export function InvoicingPage() {
  const [periodLabel, setPeriodLabel] = useState(currentPeriodLabel());
  const [workOrders, setWorkOrders] = useState<InvoiceableWorkOrderSummary[] | null>(null);
  const [batches, setBatches] = useState<InvoiceBatchSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [removingBatchId, setRemovingBatchId] = useState<string | null>(null);

  // Klantvraag 10/9/2026: tarief per project bewerken (eenmalige override, zie
  // InvoiceBatchProjectRateSummary), en "Maak conceptfactuur in Teamleader".
  const [editingRate, setEditingRate] = useState<{ batchId: string; projectId: string } | null>(null);
  const [rateInputValue, setRateInputValue] = useState('');
  const [isSavingRate, setIsSavingRate] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [creatingDraftBatchId, setCreatingDraftBatchId] = useState<string | null>(null);
  const [draftErrorByBatchId, setDraftErrorByBatchId] = useState<Record<string, string>>({});

  // Klantvraag 10/9/2026: werkbonnen van een batch tonen/corrigeren (uren/km
  // vóór "Maak conceptfactuur in Teamleader") en de werkbon-PDF-bundel
  // downloaden.
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<{ batchId: string; lineId: string } | null>(null);
  const [hoursInputValue, setHoursInputValue] = useState('');
  const [kmInputValue, setKmInputValue] = useState('');
  const [noteInputValue, setNoteInputValue] = useState('');
  const [isSavingAdjustment, setIsSavingAdjustment] = useState(false);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);

  const load = useCallback(async (period: string) => {
    try {
      const [invoiceableResponse, batchesResponse] = await Promise.all([
        invoiceBatchesApi.listInvoiceable({ periodLabel: period }),
        invoiceBatchesApi.list({ periodLabel: period }),
      ]);
      setWorkOrders(invoiceableResponse.workOrders);
      setBatches(batchesResponse.batches);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Kon het facturatie-overzicht niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load(periodLabel);
  }, [load, periodLabel]);

  const groups = useMemo(() => groupByCustomerAndProject(workOrders ?? []), [workOrders]);

  const selectedTotalSeconds = useMemo(() => {
    if (!workOrders) return 0;
    return workOrders.filter((wo) => selectedIds.has(wo.id)).reduce((sum, wo) => sum + wo.invoiceableSeconds, 0);
  }, [workOrders, selectedIds]);

  function toggleWorkOrder(workOrder: InvoiceableWorkOrderSummary) {
    setPrepareError(null);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(workOrder.id)) {
        next.delete(workOrder.id);
        if (next.size === 0) setSelectedCustomerId(null);
        return next;
      }
      // Een batch hoort bij precies één klant — een selectie bij een andere klant start dus een nieuwe selectie.
      if (selectedCustomerId && selectedCustomerId !== workOrder.customer.id) {
        setSelectedCustomerId(workOrder.customer.id);
        return new Set([workOrder.id]);
      }
      setSelectedCustomerId(workOrder.customer.id);
      next.add(workOrder.id);
      return next;
    });
  }

  async function handlePrepare() {
    if (!selectedCustomerId || selectedIds.size === 0) return;
    setIsPreparing(true);
    setPrepareError(null);
    try {
      await invoiceBatchesApi.create({
        customerId: selectedCustomerId,
        periodLabel,
        workOrderIds: Array.from(selectedIds),
      });
      setSelectedIds(new Set());
      setSelectedCustomerId(null);
      await load(periodLabel);
    } catch (err) {
      setPrepareError(err instanceof ApiRequestError ? err.message : 'Voorbereiden voor facturatie is mislukt.');
    } finally {
      setIsPreparing(false);
    }
  }

  async function handleRemoveBatch(batchId: string) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Deze facturatiebatch verwijderen? De werkbonnen komen dan weer beschikbaar om te factureren.')) return;
    setRemovingBatchId(batchId);
    try {
      await invoiceBatchesApi.remove(batchId);
      await load(periodLabel);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Verwijderen van de facturatiebatch is mislukt.');
    } finally {
      setRemovingBatchId(null);
    }
  }

  function handleStartEditRate(batchId: string, rate: InvoiceBatchProjectRateSummary) {
    setEditingRate({ batchId, projectId: rate.projectId });
    setRateInputValue(rate.overrideHourlyRateCents !== null ? (rate.overrideHourlyRateCents / 100).toFixed(2) : '');
    setRateError(null);
  }

  async function handleSaveRate(batchId: string, projectId: string) {
    const trimmed = rateInputValue.trim().replace(',', '.');
    const euros = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && (Number.isNaN(euros) || (euros as number) <= 0)) {
      setRateError('Vul een geldig bedrag in (bv. 65,00), of laat leeg om de override te wissen.');
      return;
    }
    setIsSavingRate(true);
    setRateError(null);
    try {
      await invoiceBatchesApi.setProjectRate(batchId, projectId, {
        hourlyRateCents: euros === null ? null : Math.round(euros * 100),
      });
      setEditingRate(null);
      await load(periodLabel);
    } catch (err) {
      setRateError(err instanceof ApiRequestError ? err.message : 'Opslaan van het uurtarief is mislukt.');
    } finally {
      setIsSavingRate(false);
    }
  }

  async function handleCreateTeamleaderDraft(batchId: string) {
    setCreatingDraftBatchId(batchId);
    setDraftErrorByBatchId((previous) => {
      const next = { ...previous };
      delete next[batchId];
      return next;
    });
    try {
      const response = await invoiceBatchesApi.createTeamleaderDraft(batchId);
      if (!response.syncResult.success && response.syncResult.message) {
        setDraftErrorByBatchId((previous) => ({ ...previous, [batchId]: response.syncResult.message! }));
      }
      await load(periodLabel);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Aanmaken van de conceptfactuur is mislukt.';
      setDraftErrorByBatchId((previous) => ({ ...previous, [batchId]: message }));
    } finally {
      setCreatingDraftBatchId(null);
    }
  }

  function handleStartEditLine(batchId: string, line: InvoiceBatchLineSummary) {
    setEditingLine({ batchId, lineId: line.id });
    setHoursInputValue(line.adjustedInvoiceableSeconds !== null ? formatHm(line.adjustedInvoiceableSeconds) : '');
    setKmInputValue(formatEuroInputValue(line.adjustedKmAmountCents));
    setNoteInputValue(line.adjustmentNote ?? '');
    setAdjustmentError(null);
  }

  async function handleSaveLineAdjustment(batchId: string, lineId: string) {
    const adjustedInvoiceableSeconds = parseHmInput(hoursInputValue);
    if (hoursInputValue.trim() !== '' && adjustedInvoiceableSeconds === null) {
      setAdjustmentError('Vul de uren in als uur:minuut (bv. 2:17), of laat leeg om de correctie te wissen.');
      return;
    }
    const trimmedKm = kmInputValue.trim().replace(',', '.');
    const kmEuros = trimmedKm === '' ? null : Number(trimmedKm);
    if (trimmedKm !== '' && (Number.isNaN(kmEuros) || (kmEuros as number) < 0)) {
      setAdjustmentError('Vul een geldig km-vergoedingsbedrag in (bv. 8,68), of laat leeg om de correctie te wissen.');
      return;
    }

    setIsSavingAdjustment(true);
    setAdjustmentError(null);
    try {
      await invoiceBatchesApi.setLineAdjustment(batchId, lineId, {
        adjustedInvoiceableSeconds,
        adjustedKmAmountCents: kmEuros === null ? null : Math.round(kmEuros * 100),
        adjustmentNote: noteInputValue.trim() || null,
      });
      setEditingLine(null);
      await load(periodLabel);
    } catch (err) {
      setAdjustmentError(err instanceof ApiRequestError ? err.message : 'Opslaan van de correctie is mislukt.');
    } finally {
      setIsSavingAdjustment(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Facturatie {formatPeriodLabel(periodLabel)}</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug
        </Link>
      </header>

      <div className="mb-6 flex items-center gap-3">
        <label className="text-sm text-neutral-600">
          Periode
          <input
            type="month"
            value={periodLabel}
            onChange={(event) => {
              setPeriodLabel(event.target.value);
              setSelectedIds(new Set());
              setSelectedCustomerId(null);
            }}
            className="ml-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold-dark"
          />
        </label>
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </p>
      )}

      {!workOrders && !loadError && <p className="text-neutral-500">Laden...</p>}

      {workOrders && groups.length === 0 && (
        <p className="mb-8 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600">
          Geen werkbonnen klaar voor facturatie in {formatPeriodLabel(periodLabel)}.
        </p>
      )}

      {workOrders && groups.length > 0 && (
        <div className="mb-8 overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Klant</th>
                <th className="px-4 py-3">Project</th>
                <th className="px-4 py-3">Werkbonnen</th>
                <th className="px-4 py-3">Uren</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const key = `${group.customerId}::${group.projectId}`;
                const isExpanded = expandedGroupKey === key;
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-neutral-100 last:border-0">
                      <td className="px-4 py-3 font-medium">{group.customerName}</td>
                      <td className="px-4 py-3 text-neutral-600">{group.projectName}</td>
                      <td className="px-4 py-3 text-neutral-600">{group.workOrders.length}</td>
                      <td className="px-4 py-3 text-neutral-600">{formatHm(group.totalSeconds)} u</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setExpandedGroupKey(isExpanded ? null : key)}
                          className="text-sm font-medium text-swatt-gold-dark underline"
                        >
                          {isExpanded ? 'Verbergen' : 'Werkbonnen tonen'}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-neutral-100 bg-neutral-50/60 last:border-0">
                        <td colSpan={5} className="px-4 py-3">
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs uppercase tracking-wide text-neutral-400">
                              <tr>
                                <th className="w-8 py-1" />
                                <th className="py-1">Werkbon</th>
                                <th className="py-1">Ondertekend</th>
                                <th className="py-1">Medewerker(s)</th>
                                <th className="py-1 text-right">Uren</th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.workOrders.map((workOrder) => (
                                <tr key={workOrder.id} className="border-t border-neutral-100">
                                  <td className="py-2">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.has(workOrder.id)}
                                      onChange={() => toggleWorkOrder(workOrder)}
                                      className="h-4 w-4"
                                    />
                                  </td>
                                  <td className="py-2 font-medium">{workOrder.workOrderNumber}</td>
                                  <td className="py-2 text-neutral-600">{formatDate(workOrder.signedAt)}</td>
                                  <td className="py-2 text-neutral-600">{workOrder.employeeDisplayNames.join(', ')}</td>
                                  <td className="py-2 text-right text-neutral-600">{formatHm(workOrder.invoiceableSeconds)} u</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-8 flex flex-col gap-3 rounded-xl border border-swatt-gold bg-amber-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-neutral-800">
            {selectedIds.size} werkbon(nen) geselecteerd — {formatHm(selectedTotalSeconds)} factureerbare uren
          </p>
          <button
            type="button"
            onClick={() => void handlePrepare()}
            disabled={isPreparing}
            className="rounded-lg bg-swatt-gold-dark px-4 py-3 text-sm font-semibold text-white active:opacity-80 disabled:opacity-50"
          >
            {isPreparing ? 'Bezig...' : 'Voorbereiden voor facturatie'}
          </button>
        </div>
      )}
      {prepareError && <p className="mb-8 text-sm text-red-700">{prepareError}</p>}

      <section>
        <h2 className="mb-3 text-lg font-bold tracking-tight">Voorbereide facturatiebatches</h2>
        {batches && batches.length === 0 && (
          <p className="text-sm text-neutral-500">Nog geen batches voorbereid voor {formatPeriodLabel(periodLabel)}.</p>
        )}
        {batches && batches.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3">Klant</th>
                  <th className="px-4 py-3">Werkbonnen</th>
                  <th className="px-4 py-3">Uren</th>
                  <th className="px-4 py-3">Tarieven (per project)</th>
                  <th className="px-4 py-3">Voorbereid op</th>
                  <th className="px-4 py-3">Teamleader</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const isBatchExpanded = expandedBatchId === batch.id;
                  const weekGroups = weekPdfGroupsForBatch(batch);
                  return (
                  <Fragment key={batch.id}>
                    <tr className="border-b border-neutral-100 last:border-0 align-top">
                      <td className="px-4 py-3 font-medium">{batch.customerName}</td>
                      <td className="px-4 py-3 text-neutral-600">
                        <button
                          type="button"
                          onClick={() => setExpandedBatchId(isBatchExpanded ? null : batch.id)}
                          className="text-sm font-medium text-swatt-gold-dark underline"
                        >
                          {batch.lines.length} werkbon(nen) {isBatchExpanded ? '(verbergen)' : '(tonen)'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-neutral-600">{formatHm(batch.totalInvoiceableSeconds)} u</td>
                      <td className="px-4 py-3 text-neutral-600">
                        <ul className="space-y-1">
                          {batch.projectRates.map((rate) => {
                            const isEditing = editingRate?.batchId === batch.id && editingRate.projectId === rate.projectId;
                            return (
                              <li key={rate.projectId}>
                                <div className="flex items-center gap-1">
                                  <span className="font-medium text-neutral-700">{rate.projectName}:</span>
                                  {isEditing ? (
                                    <>
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        value={rateInputValue}
                                        onChange={(event) => setRateInputValue(event.target.value)}
                                        placeholder="65,00"
                                        className="w-20 rounded border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-swatt-gold-dark"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => void handleSaveRate(batch.id, rate.projectId)}
                                        disabled={isSavingRate}
                                        className="text-xs font-semibold text-swatt-gold-dark underline disabled:opacity-50"
                                      >
                                        {isSavingRate ? '...' : 'Opslaan'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingRate(null)}
                                        disabled={isSavingRate}
                                        className="text-xs text-neutral-500 underline"
                                      >
                                        Annuleren
                                      </button>
                                    </>
                                  ) : rate.defaultHourlyRateCents !== null ? (
                                    <span>{formatEuroCents(rate.defaultHourlyRateCents)} (standaard)</span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => handleStartEditRate(batch.id, rate)}
                                      className="underline decoration-dotted underline-offset-2"
                                    >
                                      {rate.overrideHourlyRateCents !== null
                                        ? `${formatEuroCents(rate.overrideHourlyRateCents)} (eenmalig)`
                                        : 'nog niet ingesteld'}
                                    </button>
                                  )}
                                </div>
                                {isEditing && rateError && <p className="mt-1 text-xs text-red-700">{rateError}</p>}
                              </li>
                            );
                          })}
                        </ul>
                      </td>
                      <td className="px-4 py-3 text-neutral-600">{formatDate(batch.createdAt)}</td>
                      <td className="px-4 py-3">
                        {batch.status === 'DRAFT' && !batch.teamleaderSyncError && (
                          <span className="rounded-full bg-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-600">
                            Nog niet verstuurd
                          </span>
                        )}
                        {batch.status === 'DRAFT' && batch.teamleaderSyncError && (
                          <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-700">Mislukt</span>
                        )}
                        {(batch.status === 'SUBMITTED_TO_TEAMLEADER' || batch.status === 'INVOICED') && (
                          <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">
                            Conceptfactuur aangemaakt
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {batch.status === 'DRAFT' && (
                          <button
                            type="button"
                            onClick={() => void handleCreateTeamleaderDraft(batch.id)}
                            disabled={creatingDraftBatchId === batch.id || !allProjectRatesSet(batch)}
                            title={
                              !allProjectRatesSet(batch)
                                ? `Vul eerst een uurtarief in voor: ${batch.projectRates
                                    .filter((rate) => rate.effectiveHourlyRateCents === null)
                                    .map((rate) => rate.projectName)
                                    .join(', ')}.`
                                : undefined
                            }
                            className="mr-3 text-sm font-medium text-swatt-gold-dark underline disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline"
                          >
                            {creatingDraftBatchId === batch.id
                              ? 'Bezig...'
                              : batch.teamleaderSyncError
                                ? 'Opnieuw proberen'
                                : 'Maak conceptfactuur in Teamleader'}
                          </button>
                        )}
                        {batch.status === 'DRAFT' && (
                          <button
                            type="button"
                            onClick={() => void handleRemoveBatch(batch.id)}
                            disabled={removingBatchId === batch.id}
                            className="text-sm font-medium text-red-700 underline disabled:opacity-50"
                          >
                            {removingBatchId === batch.id ? 'Bezig...' : 'Verwijderen'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {draftErrorByBatchId[batch.id] && (
                      <tr className="border-b border-neutral-100 bg-red-50/60 last:border-0">
                        <td colSpan={7} className="px-4 py-2 text-xs text-red-700">
                          {draftErrorByBatchId[batch.id]}
                        </td>
                      </tr>
                    )}
                    {isBatchExpanded && (
                      <tr className="border-b border-neutral-100 bg-neutral-50/60 last:border-0">
                        <td colSpan={7} className="px-4 py-3">
                          {/* Klantvraag 10/9/2026 — "werkbonnen exporteren per klant/per maand of per klant/per week in 1 pdf". */}
                          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-200 pb-3 text-sm">
                            <span className="font-medium text-neutral-700">Download werkbonnen (PDF):</span>
                            <a
                              href={invoiceBatchesApi.workOrderPdfBundleUrl(batch.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-swatt-gold-dark underline"
                            >
                              Volledige maand ({batch.lines.length})
                            </a>
                            {weekGroups.map((week) => (
                              <a
                                key={week.weekKey}
                                href={invoiceBatchesApi.workOrderPdfBundleUrl(batch.id, week.weekKey)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-swatt-gold-dark underline"
                              >
                                Week {week.weekNumber} ({week.lineCount})
                              </a>
                            ))}
                          </div>

                          {/* Klantvraag 10/9/2026 — gefactureerde uren/km per werkbon corrigeren vóór "Maak conceptfactuur in Teamleader". */}
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs uppercase tracking-wide text-neutral-400">
                              <tr>
                                <th className="py-1">Werkbon</th>
                                <th className="py-1">Ondertekend</th>
                                <th className="py-1">Medewerker(s)</th>
                                <th className="py-1 text-right">Uren</th>
                                <th className="py-1 text-right">Km-vergoeding</th>
                                <th className="py-1" />
                              </tr>
                            </thead>
                            <tbody>
                              {batch.lines.map((line) => {
                                const isEditingLine = editingLine?.batchId === batch.id && editingLine.lineId === line.id;
                                const hasHoursAdjustment = line.adjustedInvoiceableSeconds !== null;
                                const hasKmAdjustment = line.adjustedKmAmountCents !== null;
                                return (
                                  <Fragment key={line.id}>
                                    <tr className="border-t border-neutral-100 align-top">
                                      <td className="py-2 font-medium">{line.workOrderNumber}</td>
                                      <td className="py-2 text-neutral-600">{formatDate(line.signedAt)}</td>
                                      <td className="py-2 text-neutral-600">{line.employeeDisplayNames.join(', ')}</td>
                                      <td className="py-2 text-right text-neutral-600">
                                        {isEditingLine ? (
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            value={hoursInputValue}
                                            onChange={(event) => setHoursInputValue(event.target.value)}
                                            placeholder={formatHm(line.invoiceableSeconds)}
                                            className="w-16 rounded border border-neutral-300 px-2 py-1 text-right text-sm outline-none focus:border-swatt-gold-dark"
                                          />
                                        ) : (
                                          <>
                                            {formatHm(line.effectiveInvoiceableSeconds)} u
                                            {hasHoursAdjustment && (
                                              <span className="ml-1 text-xs text-neutral-400 line-through">{formatHm(line.invoiceableSeconds)} u</span>
                                            )}
                                          </>
                                        )}
                                      </td>
                                      <td className="py-2 text-right text-neutral-600">
                                        {isEditingLine ? (
                                          <input
                                            type="text"
                                            inputMode="decimal"
                                            value={kmInputValue}
                                            onChange={(event) => setKmInputValue(event.target.value)}
                                            placeholder={formatEuroInputValue(line.kmAmountCents) || '0,00'}
                                            className="w-16 rounded border border-neutral-300 px-2 py-1 text-right text-sm outline-none focus:border-swatt-gold-dark"
                                          />
                                        ) : (
                                          <>
                                            {formatEuroCents(line.effectiveKmAmountCents)}
                                            {hasKmAdjustment && (
                                              <span className="ml-1 text-xs text-neutral-400 line-through">{formatEuroCents(line.kmAmountCents)}</span>
                                            )}
                                          </>
                                        )}
                                      </td>
                                      <td className="py-2 text-right">
                                        {batch.status !== 'DRAFT' ? null : isEditingLine ? (
                                          <div className="flex items-center justify-end gap-2">
                                            <button
                                              type="button"
                                              onClick={() => void handleSaveLineAdjustment(batch.id, line.id)}
                                              disabled={isSavingAdjustment}
                                              className="text-xs font-semibold text-swatt-gold-dark underline disabled:opacity-50"
                                            >
                                              {isSavingAdjustment ? '...' : 'Opslaan'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => setEditingLine(null)}
                                              disabled={isSavingAdjustment}
                                              className="text-xs text-neutral-500 underline"
                                            >
                                              Annuleren
                                            </button>
                                          </div>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={() => handleStartEditLine(batch.id, line)}
                                            className="text-xs text-swatt-gold-dark underline decoration-dotted underline-offset-2"
                                          >
                                            Corrigeren
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                    {isEditingLine && (
                                      <tr className="border-t border-neutral-50">
                                        <td colSpan={6} className="pb-2">
                                          <input
                                            type="text"
                                            value={noteInputValue}
                                            onChange={(event) => setNoteInputValue(event.target.value)}
                                            placeholder="Opmerking bij deze correctie (optioneel)"
                                            className="w-full max-w-md rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-swatt-gold-dark"
                                          />
                                          {adjustmentError && <p className="mt-1 text-xs text-red-700">{adjustmentError}</p>}
                                        </td>
                                      </tr>
                                    )}
                                    {!isEditingLine && line.adjustmentNote && (
                                      <tr className="border-t border-neutral-50">
                                        <td colSpan={6} className="pb-2 text-xs italic text-neutral-500">
                                          {line.adjustmentNote}
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
