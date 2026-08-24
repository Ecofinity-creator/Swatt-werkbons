import type { WorkOrderStatus, WorkOrderSyncIssueSummary } from '@swatt/shared-types';
import { WORK_ORDER_TEAMLEADER_UPLOAD_STATUS_LABELS, WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { syncIssuesApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/** Mensentaal-labels voor sectie 20's statusbadges — deze pagina toont enkel SYNC_FAILED-werkbonnen, maar de badge blijft generiek herbruikbaar. */
const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT: 'Concept',
  READY_FOR_SIGNATURE: 'Klaar om te ondertekenen',
  SIGNED: 'Ondertekend',
  SYNC_PENDING: 'Synchronisatie bezig',
  SYNC_FAILED: 'Synchronisatie mislukt',
  READY_FOR_INVOICING: 'Klaar voor facturatie',
  INVOICED: 'Gefactureerd',
};

/**
 * Backoffice-scherm "Synchronisatiefouten" (sectie 4: "supervisor ...
 * synchronisatiefouten behandelen", sectie 20: "Teamleader sync"-filter).
 * Toont enkel werkbonnen met een SYNC_FAILED-gerelateerd probleem — de
 * eigenlijke herstelactie ("Opnieuw synchroniseren") gebeurt op de
 * werkbondetailpagina zelf (zie WorkOrderReviewPage.tsx), deze pagina is
 * bewust enkel een gefilterd overzicht met doorklik.
 */
export function SyncIssuesPage() {
  const [workOrders, setWorkOrders] = useState<WorkOrderSyncIssueSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await syncIssuesApi.list();
      setWorkOrders(response.workOrders);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de synchronisatiefouten niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Synchronisatiefouten</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {!workOrders && !errorMessage && <p className="text-neutral-500">Laden...</p>}

      {workOrders?.length === 0 && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Geen openstaande synchronisatiefouten — alle ondertekende werkbonnen zijn correct gesynchroniseerd met Teamleader.
        </p>
      )}

      {workOrders && workOrders.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Werkbon</th>
                <th className="px-4 py-3">Klant / project</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Uren</th>
                <th className="px-4 py-3">PDF-upload</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {workOrders.map((workOrder) => (
                <tr key={workOrder.id} className="border-b border-neutral-100 last:border-0 align-top">
                  <td className="px-4 py-3 font-medium">{workOrder.workOrderNumber}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {workOrder.customerName} — {workOrder.projectName}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-700">
                      {WORK_ORDER_STATUS_LABELS[workOrder.status] ?? workOrder.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className={workOrder.timeTrackingSyncStatus === 'FAILED' ? 'text-red-700' : 'text-neutral-600'}>
                      {WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS[workOrder.timeTrackingSyncStatus]}
                    </p>
                    {workOrder.timeTrackingSyncError && (
                      <p className="mt-1 text-xs text-red-600">{workOrder.timeTrackingSyncError}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className={workOrder.teamleaderUploadStatus === 'TEAMLEADER_UPLOAD_FAILED' ? 'text-red-700' : 'text-neutral-600'}>
                      {WORK_ORDER_TEAMLEADER_UPLOAD_STATUS_LABELS[workOrder.teamleaderUploadStatus]}
                    </p>
                    {workOrder.teamleaderUploadError && (
                      <p className="mt-1 text-xs text-red-600">{workOrder.teamleaderUploadError}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/werkbonnen/${workOrder.id}`} className="text-sm font-medium text-swatt-gold-dark underline">
                      Openen
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
