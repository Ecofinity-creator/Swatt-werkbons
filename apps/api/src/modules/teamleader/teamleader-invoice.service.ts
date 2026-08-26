import type { PrismaClient } from '@prisma/client';
import { InvoiceBatchErrors, TeamleaderErrors } from '../../errors';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from './teamleader-auth.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';
import type { SyncResult } from './time-tracking-sync.service';

interface InvoicesDraftResponse {
  data: { id: string };
}

const WITH_DRAFT_DETAILS = {
  include: {
    customer: true,
    lines: {
      include: {
        workOrder: {
          include: {
            project: true,
            timeEntries: { include: { timeEntry: { include: { employee: true } } } },
          },
        },
      },
    },
  },
} as const;

/** Handgeschreven vorm van de query hierboven — zelfde reden als elders in deze codebase (stale gegenereerde Prisma-client in de sandbox, zie invoice-batch.service.ts). */
interface DraftBatchLineRow {
  invoiceableSeconds: number;
  workOrder: {
    workOrderNumber: string;
    description: string | null;
    project: { id: string; name: string; teamleaderId: string };
    timeEntries: Array<{ timeEntry: { employee: { displayName: string } } }>;
  };
}

interface DraftBatchRow {
  id: string;
  status: string;
  customerId: string;
  customer: { name: string; teamleaderId: string; teamleaderType: string; hourlyRateCents: number | null };
  lines: DraftBatchLineRow[];
}

interface TeamleaderConnectionInvoiceSettings {
  invoiceDepartmentId: string | null;
  invoiceTaxRateId: string | null;
  invoicePaymentTermType: string | null;
  invoicePaymentTermDays: number | null;
}

/**
 * Phase 10b — "Maak conceptfactuur in Teamleader" (sectie 17: "Indien
 * mogelijk: Maak conceptfactuur in Teamleader"). Bouwt een `invoices.draft`-
 * aanroep op vanaf een reeds voorbereide (DRAFT) InvoiceBatch. Zie
 * claude/phase10-facturatie-onderzoek.md voor het volledige API-onderzoek
 * dat hieraan voorafging.
 *
 * Volgt hetzelfde patroon als FileSyncService/TimeTrackingSyncService:
 * "verwachte" Teamleader-fouten (afwijzing, netwerkprobleem) worden nooit
 * verder gegooid — de batch blijft dan gewoon op DRAFT staan met
 * `teamleaderSyncError` gezet (business rule 9: nooit lokale data verliezen
 * door een externe storing), zodat een admin gewoon opnieuw op de knop kan
 * klikken. Validatiefouten die vóór de Teamleader-aanroep al vaststaan
 * (geen uurtarief, geen facturatie-instellingen, batch niet meer DRAFT)
 * gooien wél een gewone ApiError — die zijn niet "Teamleader is tijdelijk
 * onbereikbaar", maar "dit moet eerst ingesteld worden" (sectie 27).
 *
 * BELANGRIJK — nog niet live geverifieerd tegen een echt Teamleader-account
 * (geen OAuth-verbinding in deze sandbox), met name: het exacte formaat van
 * `unit_price.amount` (hier als JS-getal met 2 decimalen verstuurd — het
 * blueprint specificeert geen string/number-onderscheid) en of `grouped_lines`
 * zonder `section`-veld per groep aanvaard wordt. Bij een afwijzing bevat
 * `teamleaderSyncError` de volledige Teamleader-foutrespons (via
 * TeamleaderApiError, zie teamleader-client.service.ts) — dat is precies wat
 * nodig is om dit snel bij te stellen op basis van de échte foutmelding,
 * zonder Render-logtoegang nodig te hebben.
 */
export class TeamleaderInvoiceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: TeamleaderClient,
  ) {}

  async createDraftInvoice(batchId: string): Promise<SyncResult> {
    const batch = (await this.prisma.invoiceBatch.findUnique({
      where: { id: batchId },
      ...WITH_DRAFT_DETAILS,
    })) as DraftBatchRow | null;
    if (!batch) {
      throw InvoiceBatchErrors.notFound();
    }

    if (batch.status !== 'DRAFT') {
      throw InvoiceBatchErrors.alreadySubmittedToTeamleader();
    }
    if (!batch.customer.hourlyRateCents) {
      throw InvoiceBatchErrors.hourlyRateNotSet(batch.customer.name);
    }

    const connection = (await this.prisma.teamleaderConnection.findUnique({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
      select: {
        invoiceDepartmentId: true,
        invoiceTaxRateId: true,
        invoicePaymentTermType: true,
        invoicePaymentTermDays: true,
      },
    })) as TeamleaderConnectionInvoiceSettings | null;

    if (
      !connection?.invoiceDepartmentId ||
      !connection.invoiceTaxRateId ||
      !connection.invoicePaymentTermType ||
      connection.invoicePaymentTermDays === null
    ) {
      throw TeamleaderErrors.invoiceSettingsNotConfigured();
    }

    const lineItems = batch.lines.map((line) => buildLineItem(line, batch.customer.hourlyRateCents!, connection.invoiceTaxRateId!));

    // `project_id` is optioneel bij invoices.draft — enkel meesturen wanneer
    // alle werkbonnen in deze batch bij hetzelfde Teamleader-project horen
    // (een batch groepeert enkel op klant, zie InvoiceBatchService.create —
    // een klant kan meerdere projecten tegelijk laten factureren).
    const projectTeamleaderIds = new Set(batch.lines.map((line) => line.workOrder.project.teamleaderId));
    const projectId = projectTeamleaderIds.size === 1 ? [...projectTeamleaderIds][0] : undefined;

    const payload = {
      invoicee: {
        customer: {
          type: batch.customer.teamleaderType === 'company' ? ('company' as const) : ('contact' as const),
          id: batch.customer.teamleaderId,
        },
      },
      department_id: connection.invoiceDepartmentId,
      payment_term: { type: connection.invoicePaymentTermType, days: connection.invoicePaymentTermDays },
      ...(projectId ? { project_id: projectId } : {}),
      grouped_lines: [{ line_items: lineItems }],
    };

    try {
      const response = await this.client.post<InvoicesDraftResponse>('invoices.draft', payload);
      await this.prisma.invoiceBatch.update({
        where: { id: batchId },
        data: {
          status: 'SUBMITTED_TO_TEAMLEADER',
          teamleaderInvoiceId: response.data.id,
          teamleaderSubmittedAt: new Date(),
          teamleaderSyncError: null,
        },
      });
      return { success: true, message: null };
    } catch (err) {
      const message =
        err instanceof TeamleaderApiError
          ? TeamleaderErrors.syncFailed(err.message).message
          : TeamleaderErrors.syncFailed('onbekende fout').message;
      // Bewust GEEN status-wijziging — de batch blijft op DRAFT staan (business rule 9), enkel de foutmelding wordt bijgewerkt.
      await this.prisma.invoiceBatch.update({ where: { id: batchId }, data: { teamleaderSyncError: message } });
      return { success: false, message };
    }
  }
}

function buildLineItem(line: DraftBatchLineRow, hourlyRateCents: number, taxRateId: string) {
  const hours = Math.round((line.invoiceableSeconds / 3600) * 100) / 100;
  const employeeNames = Array.from(new Set(line.workOrder.timeEntries.map((entry) => entry.timeEntry.employee.displayName))).sort();
  const description = `${line.workOrder.workOrderNumber} — ${line.workOrder.project.name}: ${line.workOrder.description ?? 'Werkzaamheden'} (${employeeNames.join(', ')})`;

  return {
    quantity: hours,
    description,
    unit_price: { amount: Math.round(hourlyRateCents) / 100, currency: 'EUR' },
    tax_rate_id: taxRateId,
  };
}
