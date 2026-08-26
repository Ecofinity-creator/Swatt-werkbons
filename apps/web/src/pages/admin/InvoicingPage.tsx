import type { InvoiceBatchSummary, InvoiceableWorkOrderSummary } from '@swatt/shared-types';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { customersApi, invoiceBatchesApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/** "€ 65,00" — of "niet ingesteld" wanneer nog geen uurtarief gekozen is (zie Customer.hourlyRateCents). */
function formatEuroCents(cents: number | null): string {
  if (cents === null) return 'niet ingesteld';
  return `€ ${(cents / 100).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
 * Teamleader"-knop op elke DRAFT-batch (zie claude/phase10-facturatie-onderzoek.md
 * — Steven koos "tarief per klant", vandaar het bewerkbare uurtarief hier per
 * batch). Werkbonnen selecteren en "voorbereiden voor facturatie" blijft de
 * eerste, lokale stap (InvoiceBatch/InvoiceBatchLine); de Teamleader-stap
 * hieronder is een losse, latere actie op een reeds voorbereide batch — zie
 * TeamleaderInvoiceService voor de volledige toelichting.
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

  // Phase 10b — sectie 17: uurtarief per klant bewerken, en "Maak conceptfactuur in Teamleader".
  const [editingRateBatchId, setEditingRateBatchId] = useState<string | null>(null);
  const [rateInputValue, setRateInputValue] = useState('');
  const [isSavingRate, setIsSavingRate] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [creatingDraftBatchId, setCreatingDraftBatchId] = useState<string | null>(null);
  const [draftErrorByBatchId, setDraftErrorByBatchId] = useState<Record<string, string>>({});

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

  function handleStartEditRate(batch: InvoiceBatchSummary) {
    setEditingRateBatchId(batch.id);
    setRateInputValue(batch.customerHourlyRateCents !== null ? (batch.customerHourlyRateCents / 100).toFixed(2) : '');
    setRateError(null);
  }

  async function handleSaveRate(batch: InvoiceBatchSummary) {
    const trimmed = rateInputValue.trim().replace(',', '.');
    const euros = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && (Number.isNaN(euros) || (euros as number) <= 0)) {
      setRateError('Vul een geldig bedrag in (bv. 65,00), of laat leeg om het tarief te wissen.');
      return;
    }
    setIsSavingRate(true);
    setRateError(null);
    try {
      await customersApi.updateHourlyRate(batch.customerId, { hourlyRateCents: euros === null ? null : Math.round(euros * 100) });
      setEditingRateBatchId(null);
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
                  <th className="px-4 py-3">Uurtarief</th>
                  <th className="px-4 py-3">Voorbereid op</th>
                  <th className="px-4 py-3">Teamleader</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <Fragment key={batch.id}>
                    <tr className="border-b border-neutral-100 last:border-0 align-top">
                      <td className="px-4 py-3 font-medium">{batch.customerName}</td>
                      <td className="px-4 py-3 text-neutral-600">{batch.lines.map((line) => line.workOrderNumber).join(', ')}</td>
                      <td className="px-4 py-3 text-neutral-600">{formatHm(batch.totalInvoiceableSeconds)} u</td>
                      <td className="px-4 py-3 text-neutral-600">
                        {editingRateBatchId === batch.id ? (
                          <div className="flex items-center gap-1">
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
                              onClick={() => void handleSaveRate(batch)}
                              disabled={isSavingRate}
                              className="text-xs font-semibold text-swatt-gold-dark underline disabled:opacity-50"
                            >
                              {isSavingRate ? '...' : 'Opslaan'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingRateBatchId(null)}
                              disabled={isSavingRate}
                              className="text-xs text-neutral-500 underline"
                            >
                              Annuleren
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleStartEditRate(batch)}
                            className="underline decoration-dotted underline-offset-2"
                          >
                            {formatEuroCents(batch.customerHourlyRateCents)}
                          </button>
                        )}
                        {editingRateBatchId === batch.id && rateError && <p className="mt-1 text-xs text-red-700">{rateError}</p>}
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
                            disabled={creatingDraftBatchId === batch.id || !batch.customerHourlyRateCents}
                            title={!batch.customerHourlyRateCents ? 'Stel eerst een uurtarief in voor deze klant.' : undefined}
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
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
