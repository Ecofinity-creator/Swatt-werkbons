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
            createdByEmployee: true,
            timeEntries: { include: { timeEntry: { include: { employee: true } } } },
          },
        },
      },
    },
    projectRates: true,
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
    /** Sectie 34-scenario: wie de werkbon aanmaakte — gebruikt als "eigenaar" van de km-regel wanneer meerdere medewerkers op dezelfde werkbon registreerden. */
    createdByEmployeeId: string;
    createdByEmployee: { id: string; displayName: string };
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
      /** Klantvraag 10/9/2026 — verkoopprijs per uur, `null` zolang nog niet ingesteld. */
      hourlyRateCents: number | null;
    };
    timeEntries: Array<{
      timeEntry: {
        startedAt: Date;
        endedAt: Date | null;
        pausedSeconds: number;
        employee: { id: string; displayName: string };
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
  /** Facturatie: eenmalige tariefoverrides per project op déze batch (zie InvoiceBatchProjectRate in schema.prisma). */
  projectRates: Array<{ projectId: string; hourlyRateCents: number }>;
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
 * Klantvraag 10/9/2026 — twee wijzigingen t.o.v. Phase 10b:
 *
 * 1) Facturatie: tarief per PROJECT i.p.v. per medewerker ("de verkoopprijs
 *    hangt af van het project, niet van de technieker"). Elke werkbon in de
 *    batch wordt hier geprijsd met `Project.hourlyRateCents`, of (ontbreekt
 *    dat nog) de eenmalige override die een admin voor déze batch invulde
 *    (InvoiceBatchProjectRate, zie InvoiceBatchService.setProjectRate).
 *    `Employee.defaultHourlyRateCents`/`Customer.hourlyRateCents` worden
 *    hier bewust niet meer gebruikt.
 *
 * 2) Factuuropmaak: elke `grouped_lines`-groep krijgt nu een `section` —
 *    een vetgedrukte hoofding op de Teamleader-factuur met de ISO-week en de
 *    naam van de technieker (bv. "Week 32 - Peter Janssens"), naar het
 *    voorbeeld dat Steven aanleverde. Vóór deze wijziging bevatte
 *    `grouped_lines` altijd precies één groep met alle regels samen; nu is
 *    het één groep per (technieker, project, ISO-week) — de overurendrempel
 *    zelf blijft wél berekend per Project.overtimeThresholdType (dag of
 *    week, zie splitEffectiveHours hieronder), enkel de FACTUURWEERGAVE
 *    groepeert altijd per kalenderweek.
 *
 *    LET OP — de exacte vorm van Teamleader's `section`-veld op
 *    `grouped_lines` kon (nog) niet rechtstreeks tegen de actuele, live
 *    OpenAPI-spec geverifieerd worden (het gearchiveerde `apiary.apib` is
 *    verouderd; de opvolger, `@teamleader/focus-api-specification` op npm,
 *    is te groot om via de beschikbare tools volledig op te halen). Op basis
 *    van indirect bewijs — Teamleader's algemene API-conventie om verwante
 *    velden te nesten (zoals `unit_price: {amount, tax}` en `payment_term:
 *    {type, days}` hierboven), en een extern leesmodel dat de
 *    gegroepeerde-regel-hoofding op `invoices.info` als `group_section_title`
 *    (dus een gestructureerd `section.title`) omschrijft — is hieronder
 *    gekozen voor `section: { title: string }`. Dit zit bewust geïsoleerd in
 *    één functie (`buildSection` hieronder): geeft Teamleader hier een fout
 *    op terug (zichtbaar in `teamleaderSyncError`, business rule 9 — de
 *    batch gaat dan niet verloren), dan volstaat het die ene functie aan te
 *    passen (bv. terugvallen op een platte string) op basis van de exacte
 *    foutmelding.
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

    const rateByProjectId = resolveProjectRateCents(batch);
    const missingRateNames = Array.from(rateByProjectId.values())
      .filter((project) => project.rateCents === null)
      .map((project) => project.projectName)
      .sort();
    if (missingRateNames.length > 0) {
      throw InvoiceBatchErrors.projectHourlyRateNotSet(missingRateNames);
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

    const groupedLines = buildGroupedLinesForBatch(batch, rateByProjectId, connection.invoiceTaxRateId!);

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
      grouped_lines: groupedLines,
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
 * Bepaalt, voor elk project dat op minstens één werkbon van deze batch
 * voorkomt, het tarief waarmee de uren geprijsd worden: de eenmalige override
 * op déze batch (InvoiceBatchProjectRate) heeft voorrang op het
 * standaardtarief uit de projectinstellingen (Project.hourlyRateCents).
 * `rateCents: null` betekent dat er voor dat project nog geen van beide is
 * ingevuld — `createDraftInvoice` weigert dan de Teamleader-aanroep (zie
 * hierboven). Zelfde resolutielogica als InvoiceBatchService.resolveProjectRates
 * (bewust lokaal gedupliceerd, zie de toelichting bovenaan dit bestand).
 */
function resolveProjectRateCents(batch: DraftBatchRow): Map<string, { projectName: string; rateCents: number | null }> {
  const overrideByProjectId = new Map(batch.projectRates.map((rate) => [rate.projectId, rate.hourlyRateCents]));
  const result = new Map<string, { projectName: string; rateCents: number | null }>();
  for (const line of batch.lines) {
    const project = line.workOrder.project;
    const overrideCents = overrideByProjectId.get(project.id) ?? null;
    result.set(project.id, {
      projectName: project.name,
      rateCents: overrideCents ?? project.hourlyRateCents ?? null,
    });
  }
  return result;
}

/** Zelfde formule als invoice-batch.service.ts/work-order-pdf-document.ts/time-tracking-sync.service.ts — bewust lokaal gehouden, zie de toelichting daar. */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

type LineItem = { quantity: number; description: string; unit_price: { amount: number; tax: 'excluding' }; tax_rate_id: string };

/** Eén Teamleader `grouped_lines`-groep: een vetgedrukte hoofding ("Week N - naam") boven een reeks factuurregels. */
interface WeekGroup {
  employeeId: string;
  displayName: string;
  projectId: string;
  project: DraftBatchLineRow['workOrder']['project'];
  /** ISO-8601-weeksleutel ("YYYY-Wnn") — zie isoWeekKeyOf hieronder. */
  weekKey: string;
  workOrderNumbers: Set<string>;
  normalHours: number;
  overtimeHours: number;
  kmItems: LineItem[];
}

/**
 * Bouwt de volledige `grouped_lines`-array op: één groep per (technieker,
 * project, ISO-week), elk met een vetgedrukte `section`-hoofding ("Week N -
 * naam", klantvraag 10/9/2026). Prijzing gebeurt per PROJECT
 * (`rateByProjectId`), niet meer per technieker — de technieker bepaalt hier
 * enkel nog in wélke hoofding zijn/haar uren terechtkomen, zodat de klant kan
 * zien wie welke uren die week uitvoerde.
 *
 * Twee stappen, bewust gescheiden:
 * 1) Normaal/overuren correct splitsen — dit MOET gebeuren op basis van
 *    Project.overtimeThresholdType (dag- of weekdrempel, sectie 1), exact
 *    zoals vóór deze wijziging (zie splitEffectiveHours hieronder).
 * 2) Het RESULTAAT daarvan groeperen voor de factuurWEERGAVE, altijd per
 *    kalenderweek — ook op een project met een dagdrempel (DAILY): meerdere
 *    dagbedragen binnen dezelfde week worden dan samengevoegd tot één
 *    weekhoofding, wat Steven expliciet vroeg ("hoofding in het vet per
 *    week"), zonder de correctheid van de dagdrempel-berekening zelf aan te
 *    tasten.
 */
function buildGroupedLinesForBatch(
  batch: DraftBatchRow,
  rateByProjectId: Map<string, { projectName: string; rateCents: number | null }>,
  taxRateId: string,
): Array<{ section: { title: string }; line_items: LineItem[] }> {
  interface PeriodAccumulator {
    seconds: number;
    /** ISO-week van dit period-bucket — een DAILY-periode ligt altijd binnen precies één ISO-week. */
    weekKey: string;
  }
  interface EmployeeProjectBucket {
    employeeId: string;
    displayName: string;
    project: DraftBatchLineRow['workOrder']['project'];
    periodsByKey: Map<string, PeriodAccumulator>;
  }

  const empProjectBuckets = new Map<string, EmployeeProjectBucket>();
  const weekGroups = new Map<string, WeekGroup>();

  function weekGroupFor(employeeId: string, displayName: string, project: DraftBatchLineRow['workOrder']['project'], weekKey: string): WeekGroup {
    const key = `${employeeId}|${project.id}|${weekKey}`;
    let group = weekGroups.get(key);
    if (!group) {
      group = {
        employeeId,
        displayName,
        projectId: project.id,
        project,
        weekKey,
        workOrderNumbers: new Set(),
        normalHours: 0,
        overtimeHours: 0,
        kmItems: [],
      };
      weekGroups.set(key, group);
    }
    return group;
  }

  // Stap 1: uren bucketen per (technieker, project) → per periode (dag/week
  // naargelang de overurendrempel), en meteen de bijhorende weekgroep
  // aanmaken/vullen met werkbonnummers.
  for (const line of batch.lines) {
    const project = line.workOrder.project;
    for (const entry of line.workOrder.timeEntries) {
      const seconds = computeWorkedSeconds(entry.timeEntry);
      if (seconds <= 0) continue;

      const employee = entry.timeEntry.employee;
      const bucketKey = `${employee.id}|${project.id}`;
      const periodKey =
        project.overtimeThresholdType === 'DAILY' ? dayKeyOf(entry.timeEntry.startedAt) : isoWeekKeyOf(entry.timeEntry.startedAt);
      const weekKey = isoWeekKeyOf(entry.timeEntry.startedAt);

      if (!empProjectBuckets.has(bucketKey)) {
        empProjectBuckets.set(bucketKey, { employeeId: employee.id, displayName: employee.displayName, project, periodsByKey: new Map() });
      }
      const bucket = empProjectBuckets.get(bucketKey)!;
      const period = bucket.periodsByKey.get(periodKey) ?? { seconds: 0, weekKey };
      period.seconds += seconds;
      bucket.periodsByKey.set(periodKey, period);

      const group = weekGroupFor(employee.id, employee.displayName, project, weekKey);
      group.workOrderNumbers.add(line.workOrder.workOrderNumber);
    }
  }

  // Stap 2: per periode normaal/overuren splitsen (dag- of weekdrempel), en
  // het resultaat optellen in de bijhorende weekgroep.
  for (const bucket of empProjectBuckets.values()) {
    for (const period of bucket.periodsByKey.values()) {
      const totalHours = period.seconds / 3600;
      let normalHours = totalHours;
      let overtimeHours = 0;
      if (bucket.project.overtimeApplies) {
        const split = splitEffectiveHours(totalHours, {
          overtimeThresholdType: bucket.project.overtimeThresholdType,
          overtimeWeeklyThresholdHours: bucket.project.overtimeWeeklyThresholdHours,
        });
        normalHours = split.normalHours;
        overtimeHours = split.overtimeHours;
      }
      const group = weekGroupFor(bucket.employeeId, bucket.displayName, bucket.project, period.weekKey);
      group.normalHours += normalHours;
      group.overtimeHours += overtimeHours;
    }
  }

  addKmItemsToGroups(batch, weekGroupFor, taxRateId);

  return Array.from(weekGroups.values())
    .filter((group) => group.normalHours > 0 || group.overtimeHours > 0 || group.kmItems.length > 0)
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey) || a.displayName.localeCompare(b.displayName))
    .map((group) => {
      const rate = rateByProjectId.get(group.projectId)!;
      const { normalPercent, overtimePercent } = computeRatePercent(group.project);
      const workOrderRefs = Array.from(group.workOrderNumbers).sort().join(', ');

      const items: LineItem[] = [];
      const normalHours = Math.round(group.normalHours * 100) / 100;
      const overtimeHours = Math.round(group.overtimeHours * 100) / 100;
      if (normalHours > 0) {
        items.push(buildLineItem(normalHours, rate.rateCents!, normalPercent, taxRateId, `${workOrderRefs} — Werkuren`));
      }
      if (overtimeHours > 0) {
        items.push(buildLineItem(overtimeHours, rate.rateCents!, overtimePercent, taxRateId, `${workOrderRefs} — Overuren`));
      }
      items.push(...group.kmItems);

      return { section: buildSection(sectionTitle(group)), line_items: items };
    });
}

/** "Week 32 - Peter Janssens" — klantvraag 10/9/2026: "een hoofding in het vet per week met daarin de week en de naam van de technieker." */
function sectionTitle(group: WeekGroup): string {
  const weekNumber = Number(group.weekKey.split('-W')[1]);
  return `Week ${weekNumber} - ${group.displayName}`;
}

/**
 * Zie het uitgebreide commentaar bovenaan dit bestand over de (nog niet
 * live-geverifieerde) vorm van Teamleader's `section`-veld. Bewust in één
 * kleine functie geïsoleerd zodat dit later, indien nodig, op één plek
 * aangepast kan worden (bv. naar een platte string) zonder de rest van de
 * groeperingslogica te raken.
 */
function buildSection(title: string): { title: string } {
  return { title };
}

/**
 * Phase 12, deel D (sectie 5) — één "verplaatsingskosten"-regel per werkbon
 * met een bevroren `kmAmountCents` (WorkOrderSignatureService/
 * WeeklyApprovalService berekenden dit al op het moment van ondertekenen).
 * Klantvraag 10/9/2026: deze regel hoort nu onder dezelfde weekhoofding als
 * de uren van de technieker die de werkbon aanmaakte (`createdByEmployeeId`)
 * — bij meerdere technici op één werkbon (sectie 8) is dat de persoon die de
 * werkbon startte, een redelijke aanname voor "wie er reisde", zonder de
 * verplaatsingskost te moeten opsplitsen over meerdere technici.
 */
function addKmItemsToGroups(
  batch: DraftBatchRow,
  weekGroupFor: (employeeId: string, displayName: string, project: DraftBatchLineRow['workOrder']['project'], weekKey: string) => WeekGroup,
  taxRateId: string,
): void {
  for (const line of batch.lines) {
    const workOrder = line.workOrder;
    if (workOrder.kmAmountCents === null || workOrder.kmAmountCents <= 0) continue;

    const ownEntries = workOrder.timeEntries.filter((entry) => entry.timeEntry.employee.id === workOrder.createdByEmployeeId);
    const candidateEntries = ownEntries.length > 0 ? ownEntries : workOrder.timeEntries;
    // Kan in de praktijk niet voorkomen (elke werkbon heeft minstens één
    // tijdregistratie vóór ze factureerbaar wordt) — defensief overgeslagen
    // i.p.v. een crash, business rule 9.
    if (candidateEntries.length === 0) continue;

    const earliest = candidateEntries.reduce((a, b) => (a.timeEntry.startedAt < b.timeEntry.startedAt ? a : b));
    const weekKey = isoWeekKeyOf(earliest.timeEntry.startedAt);

    const group = weekGroupFor(workOrder.createdByEmployeeId, workOrder.createdByEmployee.displayName, workOrder.project, weekKey);
    group.workOrderNumbers.add(workOrder.workOrderNumber);
    group.kmItems.push({
      quantity: 1,
      description: `${workOrder.workOrderNumber} — verplaatsingskosten`,
      unit_price: { amount: workOrder.kmAmountCents / 100, tax: 'excluding' as const },
      tax_rate_id: taxRateId,
    });
  }
}

/** Bouwt één Teamleader-factuurregel op basis van uren × basistarief × toeslagpercentage. */
function buildLineItem(hours: number, baseRateCents: number, ratePercent: number, taxRateId: string, description: string): LineItem {
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
