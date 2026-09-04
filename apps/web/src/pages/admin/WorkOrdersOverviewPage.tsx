import type { WorkOrderOverviewItemSummary, WorkOrderStatus, WorkOrderTeamleaderUploadStatus } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { workOrdersApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/**
 * Sectie 20 uit de oorspronkelijke projectbrief: "Werkbonnenoverzicht" —
 * SUPERVISOR+. Filters: status, ondertekend ja/nee, project, Teamleader-
 * sync (datum/werknemer via de Van/Tot-velden en dropdown hieronder; klant
 * zit vervat in het project, facturatiestatus in status zelf —
 * READY_FOR_INVOICING/INVOICED zijn WorkOrderStatus-waarden, zie
 * WorkOrderService.listForAdmin() voor de volledige toelichting).
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

const TEAMLEADER_UPLOAD_STATUS_LABELS: Record<WorkOrderTeamleaderUploadStatus, string> = {
  TEAMLEADER_UPLOAD_PENDING: 'Nog niet geüpload',
  TEAMLEADER_UPLOADED: 'Geüpload',
  TEAMLEADER_UPLOAD_FAILED: 'Upload mislukt',
};

export function WorkOrdersOverviewPage() {
  const [workOrders, setWorkOrders] = useState<WorkOrderOverviewItemSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [signed, setSigned] = useState('');
  const [teamleaderUploadStatus, setTeamleaderUploadStatus] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = useCallback(
    async (filters: { status: string; signed: string; teamleaderUploadStatus: string; from: string; to: string }) => {
      try {
        const response = await workOrdersApi.listOverview({
          status: filters.status || undefined,
          signed: filters.signed === '' ? undefined : filters.signed === 'true',
          teamleaderUploadStatus: filters.teamleaderUploadStatus || undefined,
          from: filters.from ? new Date(filters.from).toISOString() : undefined,
          to: filters.to || undefined,
        });
        setWorkOrders(response.workOrders);
        setErrorMessage(null);
      } catch (err) {
        setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon het werkbonnenoverzicht niet ophalen.');
      }
    },
    [],
  );

  useEffect(() => {
    void load({ status, signed, teamleaderUploadStatus, from: fromDate, to: toDate });
  }, [status, signed, teamleaderUploadStatus, fromDate, toDate, load]);

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Werkbonnenoverzicht</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug naar overzicht
        </Link>
      </header>

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <label className="text-sm text-neutral-600">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            <option value="">Alle statussen</option>
            {(Object.keys(STATUS_LABELS) as WorkOrderStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-neutral-600">
          Ondertekend
          <select
            value={signed}
            onChange={(e) => setSigned(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            <option value="">Alle</option>
            <option value="true">Ja</option>
            <option value="false">Nee</option>
          </select>
        </label>
        <label className="text-sm text-neutral-600">
          Teamleader-sync
          <select
            value={teamleaderUploadStatus}
            onChange={(e) => setTeamleaderUploadStatus(e.target.value)}
            className="mt-1 block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
          >
            <option value="">Alle</option>
            {(Object.keys(TEAMLEADER_UPLOAD_STATUS_LABELS) as WorkOrderTeamleaderUploadStatus[]).map((value) => (
              <option key={value} value={value}>
                {TEAMLEADER_UPLOAD_STATUS_LABELS[value]}
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

      {workOrders && workOrders.length === 0 && <p className="text-sm text-neutral-500">Geen werkbonnen voor deze filters.</p>}

      {workOrders && workOrders.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Werkbon</th>
                <th className="px-4 py-3">Klant / project</th>
                <th className="px-4 py-3">Medewerker</th>
                <th className="px-4 py-3">Datum</th>
                <th className="px-4 py-3">Uren</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Teamleader</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {workOrders.map((workOrder) => (
                <tr key={workOrder.id}>
                  <td className="px-4 py-3">
                    <Link to={`/werkbonnen/${workOrder.id}`} className="font-medium text-swatt-gold-dark underline">
                      {workOrder.workOrderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {workOrder.customerName} — {workOrder.projectName}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{workOrder.createdByEmployeeDisplayName}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-500">{formatDate(workOrder.createdAt)}</td>
                  <td className="px-4 py-3 text-neutral-600">{formatHm(workOrder.totalSeconds)}</td>
                  <td className="px-4 py-3">{STATUS_LABELS[workOrder.status]}</td>
                  <td className="px-4 py-3 text-neutral-600">{TEAMLEADER_UPLOAD_STATUS_LABELS[workOrder.teamleaderUploadStatus]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatHm(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}u${String(minutes).padStart(2, '0')}`;
}
