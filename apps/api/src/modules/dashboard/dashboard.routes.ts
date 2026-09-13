import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DashboardActiveEmployeeSummary, DashboardTodayResponseBody } from '@swatt/shared-types';
import { requireRole } from '../rbac/rbac.middleware';
import { InvoiceBatchService } from '../invoice-batches/invoice-batch.service';
import { DashboardService, type ActiveTimeEntryRecord } from './dashboard.service';

const dashboardTodayQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/**
 * Klantvraag 13/9/2026 — sectie 19 "Administrator dashboard", nooit gebouwd:
 * "wie is er nu actief aan het werk en bij welk project, hoeveel uur is er
 * vandaag al geregistreerd, hoeveel werkbonnen staan er in concept/
 * ondertekend/met syncfout, hoeveel uur staat er klaar voor facturatie...
 * nu moet je daarvoor tussen losse schermen heen en weer".
 *
 * ADMIN-only — combineert operationele (actieve timers, werkbonstatussen)
 * én financiële (klaar-voor-facturatie-uren) info over alle medewerkers
 * heen, dus dezelfde gevoeligheidsklasse als Facturatie/Uren-export/
 * Auditlog.
 *
 * `from`/`to`: expliciete ISO-tijdstippen van de lokale kalenderdag, door de
 * CLIENT berekend (browser-`Date`, dus in de tijdzone van de bezoeker) —
 * NIET hier op de server afgeleid. Zelfde les als Fase 19 (de Vercel-
 * doorstuurregel/lokale-dag-fix in de planningmodule): een Render-server
 * draait in UTC en zou rond middernacht een andere kalenderdag aanwijzen
 * dan de gebruiker in België.
 */
export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const service = new DashboardService(app.prisma);
  const invoiceBatchService = new InvoiceBatchService(app.prisma);

  app.get(
    '/admin/dashboard/today',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<DashboardTodayResponseBody> => {
      const query = dashboardTodayQuerySchema.parse(request.query);
      const from = new Date(query.from);
      const to = new Date(query.to);

      // Onafhankelijke, puur-lezende aanroepen — parallel, geen enkele
      // schrijft naar of hangt af van een andere.
      const [activeEntries, todayTotals, workOrderStatusCounts, invoiceableWorkOrders] = await Promise.all([
        service.listActiveTimeEntries(),
        service.getTodayTotals(from, to),
        service.getWorkOrderStatusCounts(),
        invoiceBatchService.listInvoiceable(),
      ]);

      return {
        activeEmployees: activeEntries.map(toActiveEmployeeSummary),
        todayTotalSeconds: todayTotals.totalSeconds,
        todayEntryCount: todayTotals.entryCount,
        workOrderStatusCounts,
        invoiceableSeconds: invoiceableWorkOrders.reduce((sum, workOrder) => sum + workOrder.invoiceableSeconds, 0),
        invoiceableWorkOrderCount: invoiceableWorkOrders.length,
      };
    },
  );
}

function toActiveEmployeeSummary(entry: ActiveTimeEntryRecord): DashboardActiveEmployeeSummary {
  return {
    id: entry.id,
    employeeDisplayName: entry.employeeDisplayName,
    projectName: entry.projectName,
    customerName: entry.customerName,
    activityType: entry.activityType,
    status: entry.status,
    startedAt: entry.startedAt.toISOString(),
    pausedSeconds: entry.pausedSeconds,
    currentPauseStartedAt: entry.currentPauseStartedAt?.toISOString() ?? null,
  };
}
