import type { WorkOrderOverviewItemSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { workOrdersApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

/**
 * Fase 11/sectie 20: "Mijn werkbonnen" — de eigen volledige werkbon-
 * geschiedenis (alle statussen, alle projecten). Vult
 * ProjectTimerPage.tsx's "Nog niet getekende werkbonnen"-sectie aan (die is
 * beperkt tot DRAFT-werkbonnen van één project): hier ziet een installateur
 * ook zijn al ondertekende/gefactureerde werkbonnen terug, over alle
 * projecten heen.
 */
export function MyWorkOrdersPage() {
  const [workOrders, setWorkOrders] = useState<WorkOrderOverviewItemSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await workOrdersApi.listMine();
      setWorkOrders(response.workOrders);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon je werkbonnen niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">Mijn werkbonnen</h1>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p className="mb-4 rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200">{errorMessage}</p>
      )}

      {workOrders === null && !errorMessage && <p className="text-neutral-400">Laden...</p>}

      {workOrders && workOrders.length === 0 && <p className="text-neutral-400">Je hebt nog geen werkbonnen.</p>}

      {workOrders && workOrders.length > 0 && (
        <ul className="space-y-3">
          {workOrders.map((workOrder) => (
            <li key={workOrder.id}>
              <Link
                to={`/werkbonnen/${workOrder.id}`}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 active:bg-neutral-800"
              >
                <span>
                  <span className="block text-sm font-semibold">{workOrder.workOrderNumber}</span>
                  <span className="block text-xs text-neutral-400">
                    {workOrder.customerName} — {workOrder.projectName}
                  </span>
                  <span className="block text-xs text-neutral-500">{formatDate(workOrder.createdAt)}</span>
                </span>
                <StatusBadge status={workOrder.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Zelfde mensentaal-labels als het backoffice-overzicht (WorkOrdersOverviewPage.tsx) — bewust hier lokaal herhaald i.p.v. gedeeld, zie de toelichting in dat bestand. */
const STATUS_LABELS: Record<WorkOrderOverviewItemSummary['status'], string> = {
  DRAFT: 'Concept',
  READY_FOR_SIGNATURE: 'Klaar om te ondertekenen',
  SIGNED: 'Ondertekend',
  SYNC_PENDING: 'Synchronisatie bezig',
  SYNC_FAILED: 'Synchronisatie mislukt',
  READY_FOR_INVOICING: 'Klaar voor facturatie',
  INVOICED: 'Gefactureerd',
};

function StatusBadge({ status }: { status: WorkOrderOverviewItemSummary['status'] }) {
  const isDraft = status === 'DRAFT';
  const isFailed = status === 'SYNC_FAILED';
  return (
    <span
      className={[
        'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
        isFailed ? 'bg-red-950 text-red-300' : isDraft ? 'bg-neutral-800 text-neutral-300' : 'bg-emerald-950 text-emerald-300',
      ].join(' ')}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
