import type { CustomerPortalWorkOrderSummary } from '@swatt/shared-types';
import { useEffect, useState } from 'react';
import { ApiRequestError, portalApi } from '../../api/client';
import { usePortalAuth } from '../../auth/PortalAuthContext';
import { Logo } from '../../components/Logo';

/**
 * Klantportaal (sectie 30) — "eindklant logt in om eigen werkbonnen/status
 * te volgen". Enkel getekende werkbonnen (de backend filtert dit al, zie
 * CustomerPortalService.listWorkOrders()), met facturatiestatus en een
 * PDF-downloadlink per werkbon.
 */
const INVOICING_STATUS_LABELS: Record<CustomerPortalWorkOrderSummary['invoicingStatus'], string> = {
  IN_PROGRESS: 'In verwerking',
  READY_FOR_INVOICING: 'Wordt gefactureerd',
  INVOICED: 'Gefactureerd',
};

const INVOICING_STATUS_STYLES: Record<CustomerPortalWorkOrderSummary['invoicingStatus'], string> = {
  IN_PROGRESS: 'bg-neutral-100 text-neutral-600',
  READY_FOR_INVOICING: 'bg-amber-100 text-amber-800',
  INVOICED: 'bg-emerald-100 text-emerald-800',
};

export function PortalWorkOrdersPage() {
  const { customer, logout } = usePortalAuth();
  const [workOrders, setWorkOrders] = useState<CustomerPortalWorkOrderSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    portalApi
      .workOrders()
      .then((response) => setWorkOrders(response.workOrders))
      .catch((error) => {
        setErrorMessage(error instanceof ApiRequestError ? error.message : 'Kon je werkbonnen niet ophalen.');
      });
  }, []);

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mx-auto mb-8 flex max-w-3xl items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size="md" />
          <div>
            <p className="text-lg font-bold leading-tight">{customer?.name}</p>
            <p className="text-xs font-medium uppercase tracking-[0.15em] text-swatt-gold-dark">Klantportaal</p>
          </div>
        </div>
        <button type="button" onClick={() => void logout()} className="text-sm text-neutral-500 underline">
          Uitloggen
        </button>
      </header>

      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Jouw werkbonnen</h1>

        {errorMessage && (
          <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </p>
        )}

        {!workOrders && !errorMessage && <p className="text-neutral-500">Laden...</p>}

        {workOrders && workOrders.length === 0 && (
          <p className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
            Er staan nog geen getekende werkbonnen voor je klaar.
          </p>
        )}

        {workOrders && workOrders.length > 0 && (
          <div className="flex flex-col gap-3">
            {workOrders.map((workOrder) => (
              <div key={workOrder.id} className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{workOrder.workOrderNumber}</p>
                    <p className="text-sm text-neutral-500">{workOrder.projectName}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${INVOICING_STATUS_STYLES[workOrder.invoicingStatus]}`}
                  >
                    {INVOICING_STATUS_LABELS[workOrder.invoicingStatus]}
                    {workOrder.invoicedPeriodLabel && ` — ${workOrder.invoicedPeriodLabel}`}
                  </span>
                </div>

                {workOrder.description && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-600">{workOrder.description}</p>
                )}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm text-neutral-500">
                  <span>
                    Ondertekend op {formatDate(workOrder.signedAt)} — {formatHm(workOrder.totalSeconds)} u
                  </span>
                  {workOrder.pdfAvailable ? (
                    <a
                      href={portalApi.pdfUrl(workOrder.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-swatt-gold-dark underline"
                    >
                      PDF downloaden
                    </a>
                  ) : (
                    <span className="text-neutral-400">PDF wordt nog voorbereid</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/** "7:30" — zelfde weergave als elders in de app (bv. InvoicingPage.tsx). */
function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
