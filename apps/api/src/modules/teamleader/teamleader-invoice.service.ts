import type { PrismaClient } from '@prisma/client';
import { InvoiceBatchErrors, TeamleaderErrors } from '../../errors';
import { computeRatePercent, splitEffectiveHours } from '../rates/rate-calculation.service';
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
    /** Phase 12, deel D (sectie 5) — bevroren km-vergoedingsbedrag, zie WorkOrderSignatureService/WeeklyApprovalService. */
    kmAmountCents: number | null;
    project: {
      id: string;
      name: string;
      teamleaderId: string;
      overtimeThresholdType: 'DAILY' | 'WEEKLY';
      overtimeWeeklyThresholdHours: number | null;
      /** Fase 12-herziening: toeslagregeling zit nu volledig en uniform op Project, niet meer per ProjectAssignment. */
      overtimeApplies: boolean;
      premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
      overtimeRatePercent: number;
      shiftWorkRatePercent: number;
      nightWorkRatePercent: number;
    };
    timeEntries: Array<{
      timeEntry: {
        startedAt: Date;
        endedAt: Date | null;
        pausedSeconds: number;
        employee: {
          id: string;
          displayName: string;
          defaultHourlyRateCents: number | null;
        };
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

    const lineItems = buildLineItemsForBatch(batch, rateByEmployeeId, connection.invoiceTaxRateId!);

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
 *
 * Phase 12, deel A: de overurendrempel (dag of week, sectie 1) geldt over de
 * volledige batch heen — een WEEKLY-drempel van bv. 39u kan pas overschreden
 * worden door de uren van meerdere werkbonnen/dagen samen op te tellen. Deze
 * functie groepeert daarom alle tijdregistraties van de hele batch per
 * (medewerker, project), bucket ze per dag of per week (naargelang
 * Project.overtimeThresholdType), en splitst pas dán normaal/overuren.
 * Ploegenwerk/nachtwerk (premiumType) geldt op alle uren van een koppeling,
 * ongeacht de drempel — zie rate-calculation.service.ts.
 */
function buildLineItemsForBatch(
  batch: DraftBatchRow,
  rateByEmployeeId: Map<string, { displayName: string; rateCents: number | null }>,
  taxRateId: string,
) {
  interface Bucket {
    employeeId: string;
    displayName: string;
    projectId: string;
    projectName: string;
    workOrderNumbers: Set<string>;
    project: DraftBatchLineRow['workOrder']['project'];
    employee: DraftBatchLineRow['workOrder']['timeEntries'][number]['timeEntry']['employee'];
    /** periodKey (dag "YYYY-MM-DD" of ISO-week "YYYY-Wnn") → seconden in die periode. */
    secondsByPeriod: Map<string, number>;
  }

  const bucketsByEmployeeProject = new Map<string, Bucket>();

  for (const line of batch.lines) {
    const project = line.workOrder.project;
    for (const entry of line.workOrder.timeEntries) {
      const seconds = computeWorkedSeconds(entry.timeEntry);
      if (seconds <= 0) continue;

      const employee = entry.timeEntry.employee;
      const key = `${employee.id}|${project.id}`;
      const periodKey =
        project.overtimeThresholdType === 'DAILY' ? dayKeyOf(entry.timeEntry.startedAt) : isoWeekKeyOf(entry.timeEntry.startedAt);

      if (!bucketsByEmployeeProject.has(key)) {
        bucketsByEmployeeProject.set(key, {
          employeeId: employee.id,
          displayName: employee.displayName,
          projectId: project.id,
          projectName: project.name,
          workOrderNumbers: new Set(),
          project,
          employee,
          secondsByPeriod: new Map(),
        });
      }
      const bucket = bucketsByEmployeeProject.get(key)!;
      bucket.workOrderNumbers.add(line.workOrder.workOrderNumber);
      bucket.secondsByPeriod.set(periodKey, (bucket.secondsByPeriod.get(periodKey) ?? 0) + seconds);
    }
  }

  return Array.from(bucketsByEmployeeProject.values()).flatMap((bucket) => {
    let normalHours = 0;
    let overtimeHours = 0;
    for (const seconds of bucket.secondsByPeriod.values()) {
      const totalHours = seconds / 3600;
      if (bucket.project.overtimeApplies) {
        const split = splitEffectiveHours(totalHours, {
          overtimeThresholdType: bucket.project.overtimeThresholdType,
          overtimeWeeklyThresholdHours: bucket.project.overtimeWeeklyThresholdHours,
        });
        normalHours += split.normalHours;
        overtimeHours += split.overtimeHours;
      } else {
        normalHours += totalHours;
      }
    }
    normalHours = Math.round(normalHours * 100) / 100;
    overtimeHours = Math.round(overtimeHours * 100) / 100;

    const employeeRate = rateByEmployeeId.get(bucket.employeeId)!;
    const { normalPercent, overtimePercent } = computeRatePercent(bucket.project);
    const workOrderRefs = Array.from(bucket.workOrderNumbers).sort().join(', ');

    const items: Array<{ quantity: number; description: string; unit_price: { amount: number; tax: 'excluding' }; tax_rate_id: string }> = [];
    if (normalHours > 0) {
      items.push(
        buildLineItem(normalHours, employeeRate.rateCents!, normalPercent, taxRateId, `${workOrderRefs} — ${bucket.projectName}: ${employeeRate.displayName}`),
      );
    }
    if (overtimeHours > 0) {
      items.push(
        buildLineItem(
          overtimeHours,
          employeeRate.rateCents!,
          overtimePercent,
          taxRateId,
          `${workOrderRefs} — ${bucket.projectName}: ${employeeRate.displayName} (overuren)`,
        ),
      );
    }
    return items;
  }).concat(buildKmLineItems(batch, taxRateId));
}

/**
 * Phase 12, deel D (sectie 5) — één aparte "Verplaatsingskosten"-regel per
 * werkbon met een bevroren `kmAmountCents` (WorkOrderSignatureService/
 * WeeklyApprovalService berekenden dit al op het moment van ondertekenen).
 * Bewust NIET meegeteld in de uren-buckets hierboven: km is een vast bedrag
 * per werkbon, geen toeslagpercentage op een uurtarief.
 */
function buildKmLineItems(batch: DraftBatchRow, taxRateId: string) {
  return batch.lines
    .filter((line) => line.workOrder.kmAmountCents !== null && line.workOrder.kmAmountCents > 0)
    .map((line) => ({
      quantity: 1,
      description: `${line.workOrder.workOrderNumber} — ${line.workOrder.project.name}: verplaatsingskosten`,
      unit_price: { amount: line.workOrder.kmAmountCents! / 100, tax: 'excluding' as const },
      tax_rate_id: taxRateId,
    }));
}

/** Bouwt één Teamleader-factuurregel op basis van uren × basistarief × toeslagpercentage. */
function buildLineItem(hours: number, baseRateCents: number, ratePercent: number, taxRateId: string, description: string) {
  const amount = Math.round(baseRateCents * (ratePercent / 100)) / 100;
  return {
    quantity: hours,
    description,
    // `unit_price.tax` is een verplicht veld volgens de officiële Teamleader-
    // API-specificatie (apiary.apib → InvoiceGroupedLinesWrite): het geeft aan
    // dat `amount` een bedrag EXCLUSIEF btw is (de enige toegestane waarde is
    // `excluding` — Teamleader berekent de btw zelf via `tax_rate_id`
    // hieronder). Live geverifieerd op 26/08/2026: zonder dit veld gaf
    // invoices.draft een 400 terug met "tax must be present" (meta.field: "tax").
    unit_price: { amount, tax: 'excluding' as const },
    tax_rate_id: taxRateId,
  };
}

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO-8601-weeknummer (maandag als eerste dag) — "YYYY-Wnn", tijdzone-onafhankelijk genoeg voor weekbucketing van werkuren. */
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
