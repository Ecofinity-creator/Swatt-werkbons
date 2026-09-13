import type { CustomerPortalWorkOrderSummary } from '@swatt/shared-types';
import type { PrismaClient } from '@prisma/client';
import { CustomerPortalErrors } from '../../errors';

/**
 * Klantportaal (sectie 30) — puur-lezende service: een klant mag hier nooit
 * iets kunnen wijzigen, enkel zijn eigen (getekende) werkbonnen en
 * facturatiestatus inzien. "Eigen" = via Project.customerId, dus enkel
 * werkbonnen van projecten die bij déze klant horen.
 */
export class CustomerPortalService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Enkel getekende werkbonnen (signature aanwezig) — een DRAFT/READY_FOR_SIGNATURE-
   * werkbon is intern werk-in-uitvoering en gaat de klant niets aan. Nieuwste
   * ondertekening eerst.
   */
  async listWorkOrders(customerId: string): Promise<CustomerPortalWorkOrderSummary[]> {
    const rows = await this.prisma.workOrder.findMany({
      where: { project: { customerId }, signature: { isNot: null } },
      orderBy: { signature: { signedAt: 'desc' } },
      select: {
        id: true,
        workOrderNumber: true,
        description: true,
        status: true,
        pdfStatus: true,
        project: { select: { name: true } },
        signature: { select: { signedAt: true } },
        timeEntries: { select: { timeEntry: { select: { startedAt: true, endedAt: true, pausedSeconds: true } } } },
        invoiceBatchLine: { select: { invoiceBatch: { select: { status: true, periodLabel: true } } } },
      },
      take: 500,
    });

    return (rows as unknown as CustomerPortalWorkOrderRow[]).map(toCustomerPortalSummary);
  }

  /**
   * Voor de PDF-download-route: haalt de werkbon enkel op wanneer die van
   * déze klant is EN al getekend — gooit anders CustomerPortalErrors.workOrderNotFound()
   * (zie de toelichting daar: bewust dezelfde fout voor "bestaat niet" als
   * "is niet van jou").
   */
  async getOwnedWorkOrder(customerId: string, workOrderId: string): Promise<{ pdfFileKey: string | null; pdfFileName: string | null; pdfStatus: string }> {
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, project: { customerId }, signature: { isNot: null } },
      select: { pdfFileKey: true, pdfFileName: true, pdfStatus: true },
    });
    if (!workOrder) {
      throw CustomerPortalErrors.workOrderNotFound();
    }
    return workOrder;
  }
}

interface CustomerPortalWorkOrderRow {
  id: string;
  workOrderNumber: string;
  description: string | null;
  status: 'DRAFT' | 'READY_FOR_SIGNATURE' | 'SIGNED' | 'SYNC_PENDING' | 'SYNC_FAILED' | 'READY_FOR_INVOICING' | 'INVOICED';
  pdfStatus: 'PDF_PENDING' | 'PDF_GENERATING' | 'PDF_READY' | 'PDF_FAILED';
  project: { name: string };
  signature: { signedAt: Date } | null;
  timeEntries: Array<{ timeEntry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number } }>;
  invoiceBatchLine: { invoiceBatch: { status: 'DRAFT' | 'SUBMITTED_TO_TEAMLEADER' | 'INVOICED'; periodLabel: string } } | null;
}

function toCustomerPortalSummary(row: CustomerPortalWorkOrderRow): CustomerPortalWorkOrderSummary {
  const totalSeconds = row.timeEntries.reduce((sum, link) => sum + computeWorkedSeconds(link.timeEntry), 0);
  const invoicingStatus = deriveInvoicingStatus(row.status);
  return {
    id: row.id,
    workOrderNumber: row.workOrderNumber,
    projectName: row.project.name,
    description: row.description,
    // signature is altijd aanwezig hier (zie de where-clausule in listWorkOrders()) — de `!` is dus veilig.
    signedAt: row.signature!.signedAt.toISOString(),
    totalSeconds,
    invoicingStatus,
    invoicedPeriodLabel: invoicingStatus === 'INVOICED' ? (row.invoiceBatchLine?.invoiceBatch.periodLabel ?? null) : null,
    pdfAvailable: row.pdfStatus === 'PDF_READY',
  };
}

/** READY_FOR_INVOICING/INVOICED zijn zelf al WorkOrderStatus-waarden (zie sectie 20) — elke andere (getekende) status is voor de klant gewoon "in verwerking", de interne Teamleader-syncdetails gaan hem niets aan. */
function deriveInvoicingStatus(
  status: CustomerPortalWorkOrderRow['status'],
): CustomerPortalWorkOrderSummary['invoicingStatus'] {
  if (status === 'INVOICED') return 'INVOICED';
  if (status === 'READY_FOR_INVOICING') return 'READY_FOR_INVOICING';
  return 'IN_PROGRESS';
}

/** Zelfde formule als work-order.service.ts/invoice-batch.service.ts se computeWorkedSeconds() — bewust hier ook gedupliceerd (bestaande codebase-conventie, geen gedeelde utility). */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}
