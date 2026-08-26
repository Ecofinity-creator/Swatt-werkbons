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
    employeeRates: true,
  },
} as const;

/** Handgeschreven vorm van de query hierboven — zelfde reden als elders in deze codebase (stale gegenereerde Prisma-client in de sandbox, zie invoice-batch.service.ts). */
interface DraftBatchLineRow {
  invoiceableSeconds: number;
  workOrder: {
    workOrderNumber: string;
    description: string | null;
    project: { id: string; name: string; teamleaderId: string };
    timeEntries: Array<{
      timeEntry: {
        startedAt: Date;
        endedAt: Date | null;
        pausedSeconds: number;
        employee: { id: string; displayName: string; defaultHourlyRateCents: number | null };
      };
    }>;
  };
}

interface DraftBatchRow {
  id: string;
  status: string;
  customerId: string;
  customer: { name: string; teamleaderId: string; teamleaderType: string; hourlyRateCents: number | null };
  lines: DraftBatchLineRow[];
  /** Facturatie: eenmalige tariefoverrides per medewerker op déze batch (zie InvoiceBatchEmployeeRate in schema.prisma). */
  employeeRates: Array<{ employeeId: string; hourlyRateCents: number }>;
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
 * Live geverifieerd op 26/08/2026 tegen het echte Teamleader-account van
 * Ecofinity: de eerste poging gaf een 400 terug ("tax must be present",
 * meta.field: "tax") — opgelost door `unit_price.tax: "excluding"` toe te
 * voegen (verplicht veld volgens apiary.apib → InvoiceGroupedLinesWrite, was
 * niet duidelijk uit het blueprint-fragment dat eerder geraadpleegd werd).
 * `grouped_lines` zonder `section`-veld per groep werd wél aanvaard. Bij een
 * afwijzing bevat `teamleaderSyncError` de volledige Teamleader-foutrespons
 * (via TeamleaderApiError, zie teamleader-client.service.ts) — dat is precies
 * wat nodig is om dit snel bij te stellen op basis van de échte foutmelding,
 * zonder Render-logtoegang nodig te hebben.
 *
 * Facturatie: tarief per medewerker i.p.v. per klant (uitbreiding na Phase
 * 10b). Elke werkbon in de batch wordt hier gesplitst in één factuurregel PER
 * MEDEWERKER die er uren op registreerde — geprijsd met diens
 * `Employee.defaultHourlyRateCents`, of (ontbreekt dat nog) de eenmalige
 * override die een admin voor déze batch invulde (InvoiceBatchEmployeeRate,
 * zie InvoiceBatchService.setEmployeeRate). `Customer.hourlyRateCents` wordt
 * hier bewust niet meer gebruikt — dat veld/de bijhorende instelling op de
 * Facturatie-pagina blijft wel bestaan (zie CustomerService), maar is sinds
 * deze uitbreiding niet meer de bron voor de conceptfactuur.
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

    const rateByEmployeeId = resolveEmployeeRateCents(batch);
    const missingRateNames = Array.from(rateByEmployeeId.values())
      .filter((employee) => employee.rateCents === null)
      .map((employee) => employee.displayName)
      .sort();
    if (missingRateNames.length > 0) {
      throw InvoiceBatchErrors.employeeHourlyRateNotSet(missingRateNames);
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

    const lineItems = batch.lines.flatMap((line) => buildLineItems(line, rateByEmployeeId, connection.invoiceTaxRateId!));

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

/**
 * Bepaalt, voor elke medewerker die op minstens één werkbon van deze batch
 * voorkomt, het tarief waarmee zijn/haar uren geprijsd worden: de eenmalige
 * override op déze batch (InvoiceBatchEmployeeRate) heeft voorrang op het
 * standaardtarief uit de instellingen (Employee.defaultHourlyRateCents).
 * `rateCents: null` betekent dat er voor die medewerker nog geen van beide is
 * ingevuld — `createDraftInvoice` weigert dan de Teamleader-aanroep (zie
 * hierboven). Zelfde resolutielogica als InvoiceBatchService.resolveEmployeeRates
 * (bewust lokaal gedupliceerd, zie de toelichting bovenaan dit bestand).
 */
function resolveEmployeeRateCents(batch: DraftBatchRow): Map<string, { displayName: string; rateCents: number | null }> {
  const overrideByEmployeeId = new Map(batch.employeeRates.map((rate) => [rate.employeeId, rate.hourlyRateCents]));
  const result = new Map<string, { displayName: string; rateCents: number | null }>();
  for (const line of batch.lines) {
    for (const entry of line.workOrder.timeEntries) {
      const employee = entry.timeEntry.employee;
      const overrideCents = overrideByEmployeeId.get(employee.id) ?? null;
      result.set(employee.id, {
        displayName: employee.displayName,
        rateCents: overrideCents ?? employee.defaultHourlyRateCents,
      });
    }
  }
  return result;
}

/** Zelfde formule als invoice-batch.service.ts/work-order-pdf-document.ts/time-tracking-sync.service.ts — bewust lokaal gehouden, zie de toelichting daar. */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

/**
 * Eén werkbon levert voortaan één factuurregel PER MEDEWERKER op (i.p.v. één
 * regel met een geblende totaal), zodat elke medewerker met zijn/haar eigen
 * tarief geprijsd wordt. `rateByEmployeeId` bevat op dit punt gegarandeerd
 * enkel geldige (niet-null) tarieven — `createDraftInvoice` heeft dat al
 * vooraf gecontroleerd.
 */
function buildLineItems(
  line: DraftBatchLineRow,
  rateByEmployeeId: Map<string, { displayName: string; rateCents: number | null }>,
  taxRateId: string,
) {
  const secondsByEmployeeId = new Map<string, number>();
  for (const entry of line.workOrder.timeEntries) {
    const employeeId = entry.timeEntry.employee.id;
    const seconds = computeWorkedSeconds(entry.timeEntry);
    secondsByEmployeeId.set(employeeId, (secondsByEmployeeId.get(employeeId) ?? 0) + seconds);
  }

  return Array.from(secondsByEmployeeId.entries())
    .filter(([, seconds]) => seconds > 0)
    .map(([employeeId, seconds]) => {
      const employee = rateByEmployeeId.get(employeeId)!;
      const hours = Math.round((seconds / 3600) * 100) / 100;
      const description = `${line.workOrder.workOrderNumber} — ${line.workOrder.project.name}: ${line.workOrder.description ?? 'Werkzaamheden'} (${employee.displayName})`;

      return {
        quantity: hours,
        description,
        // `unit_price.tax` is een verplicht veld volgens de officiële Teamleader-
        // API-specificatie (apiary.apib → InvoiceGroupedLinesWrite): het geeft aan
        // dat `amount` een bedrag EXCLUSIEF btw is (de enige toegestane waarde is
        // `excluding` — Teamleader berekent de btw zelf via `tax_rate_id`
        // hieronder). Live geverifieerd op 26/08/2026: zonder dit veld gaf
        // invoices.draft een 400 terug met "tax must be present" (meta.field: "tax").
        unit_price: { amount: Math.round(employee.rateCents!) / 100, tax: 'excluding' as const },
        tax_rate_id: taxRateId,
      };
    });
}
