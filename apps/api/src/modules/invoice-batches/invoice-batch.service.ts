import { Prisma, type PrismaClient } from '@prisma/client';
import { InvoiceBatchErrors } from '../../errors';

/**
 * `lines.workOrder.timeEntries` en `projectRates` zijn hier nodig (i.p.v. in
 * teamleader-invoice.service.ts' eigen, losse `WITH_DRAFT_DETAILS`) om
 * `resolveProjectRates()` hieronder ook te kunnen tonen op de
 * Facturatie-pagina — niet enkel op het moment van de effectieve
 * Teamleader-aanroep. Zelfde bewuste duplicatie-patroon als
 * `computeWorkedSeconds` verderop in dit bestand.
 */
const WITH_BATCH_DETAILS = {
  include: {
    customer: true,
    lines: {
      include: {
        workOrder: {
          include: {
            project: true,
            timeEntries: { include: { timeEntry: { include: { employee: true } } } },
            // Klantvraag 10/9/2026 — nodig voor de ondertekeningsdatum (per-
            // regel weergave op de Facturatie-pagina en voor de
            // week-groepering van de werkbonbundel, zie
            // invoice-batch-pdf-bundle.service.ts) en het bevroren
            // km-vergoedingsbedrag (getoond als "werkelijke" waarde naast een
            // eventuele correctie).
            signature: true,
          },
        },
      },
    },
    projectRates: true,
  },
} as const;

export interface InvoiceBatchLineRecord {
  id: string;
  workOrderId: string;
  invoiceableSeconds: number;
  /**
   * Klantvraag 10/9/2026 — "mogelijkheid om de gefactureerde km en uren aan
   * te passen vooraleer de factuur naar teamleader gaat". `null` = geen
   * correctie, de werkelijke waarde (invoiceableSeconds hiernaast resp.
   * workOrder.kmAmountCents) blijft gelden. Zie setLineAdjustment()
   * hieronder en de toelichting bij InvoiceBatchLine in schema.prisma.
   */
  adjustedInvoiceableSeconds: number | null;
  adjustedKmAmountCents: number | null;
  adjustmentNote: string | null;
  workOrder: {
    workOrderNumber: string;
    project: { name: string };
    kmAmountCents: number | null;
    signature: { signedAt: Date } | null;
    timeEntries: Array<{ timeEntry: { employee: { displayName: string } } }>;
  };
}

/** Zie InvoiceBatchProjectRateSummary in shared-types voor de betekenis van elk veld. */
export interface InvoiceBatchProjectRateRecord {
  projectId: string;
  projectName: string;
  defaultHourlyRateCents: number | null;
  overrideHourlyRateCents: number | null;
  effectiveHourlyRateCents: number | null;
}

export interface InvoiceBatchRecord {
  id: string;
  customerId: string;
  periodLabel: string;
  status: 'DRAFT' | 'SUBMITTED_TO_TEAMLEADER' | 'INVOICED';
  totalInvoiceableSeconds: number;
  createdByUserId: string;
  createdAt: Date;
  customer: { name: string; hourlyRateCents: number | null };
  lines: InvoiceBatchLineRecord[];
  /** Projecten op deze batch en hun (standaard- of eenmalig ingevuld) uurtarief — zie resolveProjectRates() hieronder. */
  projectRates: InvoiceBatchProjectRateRecord[];
  /** Sinds Phase 10b — zie InvoiceBatch in schema.prisma. */
  teamleaderInvoiceId: string | null;
  teamleaderSyncError: string | null;
  teamleaderSubmittedAt: Date | null;
}

/**
 * Handgeschreven vorm van de `WITH_BATCH_DETAILS`-query hierboven — zelfde
 * reden als elders in deze codebase (stale gegenereerde Prisma-client in de
 * sandbox). Enkel de velden die `resolveProjectRates()` nodig heeft.
 */
interface BatchWithProjectDataRow {
  lines: Array<{
    workOrder: {
      project: { id: string; name: string; hourlyRateCents: number | null };
      kmAmountCents: number | null;
      signature: { signedAt: Date } | null;
      timeEntries: Array<{
        timeEntry: {
          employee: { id: string; displayName: string };
        };
      }>;
    };
  }>;
  projectRates: Array<{ projectId: string; hourlyRateCents: number }>;
}

export interface InvoiceableWorkOrderRecord {
  id: string;
  workOrderNumber: string;
  signedAt: Date | null;
  invoiceableSeconds: number;
  customer: { id: string; name: string; hourlyRateCents: number | null };
  project: { id: string; name: string; projectNumber: string | null };
  employeeDisplayNames: string[];
}

export interface InvoiceableWorkOrderFilters {
  customerId?: string | undefined;
  projectId?: string | undefined;
  employeeId?: string | undefined;
  /** bv. "2026-08" — gefilterd op basis van WorkOrderSignature.signedAt, zie periodLabelOf() hieronder. */
  periodLabel?: string | undefined;
}

/**
 * Handgeschreven vorm van de `listInvoiceable()`-query hieronder — zelfde
 * patroon als WorkOrderTimeEntryLink in time-tracking-sync.service.ts: een
 * expliciete `as`-cast i.p.v. op Prisma's eigen inferentie te vertrouwen,
 * zodat dit bestand ook type-checkt wanneer de gegenereerde Prisma-client in
 * deze sandbox (nog) niet alle Phase 10-relaties kent (zie de toelichting
 * over `prisma generate` elders in dit project — CI genereert wél een
 * volledige, correcte client).
 */
interface InvoiceableWorkOrderRow {
  id: string;
  workOrderNumber: string;
  signature: { signedAt: Date } | null;
  project: {
    id: string;
    name: string;
    projectNumber: string | null;
    customer: { id: string; name: string; hourlyRateCents: number | null };
  };
  timeEntries: Array<{
    timeEntry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number; employee: { displayName: string } };
  }>;
}

/** Zelfde reden als InvoiceableWorkOrderRow hierboven — de vorm van de `create()`-validatiequery. */
interface CreateBatchWorkOrderRow {
  id: string;
  status: string;
  project: { customerId: string; invoicingEnabled: boolean };
  timeEntries: Array<{ timeEntry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number } }>;
  invoiceBatchLine: { id: string } | null;
}

/**
 * Phase 10 — lokaal facturatie-overzicht (sectie 17/29). Zie
 * claude/phase10-facturatie-onderzoek.md (project docs) voor het
 * Teamleader-API-onderzoek: het effectief aanmaken van een
 * `invoices.draft`-conceptfactuur in Teamleader is bewust NIET onderdeel van
 * deze service — dat is een latere uitbreiding zodra het uurtarief-vraagstuk
 * beantwoord is. Deze service beheert enkel de lokale groepering
 * (InvoiceBatch/InvoiceBatchLine).
 */
export class InvoiceBatchService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Werkbonnen die klaar zijn om in een batch opgenomen te worden: status
   * READY_FOR_INVOICING én nog niet aan een (bestaande) InvoiceBatchLine
   * gekoppeld (business rule 7). `periodLabel` wordt niet in de database
   * bewaard — gefilterd in-memory op basis van de ondertekeningsdatum,
   * pragmatisch genoeg voor het beperkte, begrensde aantal openstaande
   * werkbonnen dat dit overzicht ooit toont.
   */
  async listInvoiceable(filters: InvoiceableWorkOrderFilters = {}): Promise<InvoiceableWorkOrderRecord[]> {
    const workOrders = (await this.prisma.workOrder.findMany({
      where: {
        status: 'READY_FOR_INVOICING',
        invoiceBatchLine: null,
        // Phase 12, deel C (sectie 3): een project met invoicingEnabled=false
        // synct zijn uren/PDF gewoon naar Teamleader (nacalculatie), maar mag
        // nooit in dit overzicht verschijnen — dus nooit selecteerbaar zijn
        // voor een InvoiceBatch. Let op: `project` mag hier maar één keer als
        // sleutel voorkomen in dit object-literal — daarom hier samengevoegd
        // met filters.customerId i.p.v. een tweede `...(filters.customerId
        // ? { project: {...} } : {})`-spread, die de vorige `project`-sleutel
        // stilzwijgend zou overschrijven.
        project: {
          invoicingEnabled: true,
          ...(filters.customerId ? { customerId: filters.customerId } : {}),
        },
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(filters.employeeId ? { timeEntries: { some: { timeEntry: { employeeId: filters.employeeId } } } } : {}),
      },
      include: {
        project: { include: { customer: true } },
        signature: true,
        timeEntries: { include: { timeEntry: { include: { employee: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
    })) as InvoiceableWorkOrderRow[];

    const records: InvoiceableWorkOrderRecord[] = workOrders.map((workOrder) => ({
      id: workOrder.id,
      workOrderNumber: workOrder.workOrderNumber,
      signedAt: workOrder.signature?.signedAt ?? null,
      invoiceableSeconds: workOrder.timeEntries.reduce((sum, link) => sum + computeWorkedSeconds(link.timeEntry), 0),
      customer: {
        id: workOrder.project.customer.id,
        name: workOrder.project.customer.name,
        hourlyRateCents: workOrder.project.customer.hourlyRateCents,
      },
      project: { id: workOrder.project.id, name: workOrder.project.name, projectNumber: workOrder.project.projectNumber },
      employeeDisplayNames: Array.from(new Set(workOrder.timeEntries.map((link) => link.timeEntry.employee.displayName))).sort(),
    }));

    if (!filters.periodLabel) return records;
    return records.filter((record) => record.signedAt && periodLabelOf(record.signedAt) === filters.periodLabel);
  }

  /** Phase 10b — na een Teamleader-synchronisatiepoging heeft de route de bijgewerkte batch nodig om terug te geven (zie invoice-batch.routes.ts). */
  async getById(id: string): Promise<InvoiceBatchRecord | null> {
    const batch = (await this.prisma.invoiceBatch.findUnique({ where: { id }, ...WITH_BATCH_DETAILS })) as RawBatch | null;
    return batch ? toBatchRecord(batch) : null;
  }

  async list(filters: { customerId?: string | undefined; periodLabel?: string | undefined } = {}): Promise<InvoiceBatchRecord[]> {
    const batches = (await this.prisma.invoiceBatch.findMany({
      where: {
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.periodLabel ? { periodLabel: filters.periodLabel } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...WITH_BATCH_DETAILS,
    })) as RawBatch[];
    return batches.map(toBatchRecord);
  }

  /**
   * Vult (of wist) het eenmalige tariefoverride van één project op deze
   * batch (zie InvoiceBatchProjectRate in schema.prisma) — enkel nodig
   * zolang dat project geen `Project.hourlyRateCents` heeft. Enkel
   * toegestaan op een DRAFT-batch, zelfde reden als `remove()`: eens
   * `invoices.draft` is aangeroepen liggen de geprijsde regels al vast bij
   * Teamleader.
   */
  async setProjectRate(batchId: string, projectId: string, hourlyRateCents: number | null): Promise<InvoiceBatchRecord> {
    const batch = (await this.prisma.invoiceBatch.findUnique({ where: { id: batchId }, ...WITH_BATCH_DETAILS })) as RawBatch | null;
    if (!batch) {
      throw InvoiceBatchErrors.notFound();
    }
    if (batch.status !== 'DRAFT') {
      throw InvoiceBatchErrors.alreadySubmittedToTeamleader();
    }
    const knownProjectIds = new Set(resolveProjectRates(batch).map((rate) => rate.projectId));
    if (!knownProjectIds.has(projectId)) {
      throw InvoiceBatchErrors.projectNotOnBatch();
    }

    if (hourlyRateCents === null) {
      await this.prisma.invoiceBatchProjectRate.deleteMany({ where: { invoiceBatchId: batchId, projectId } });
    } else {
      await this.prisma.invoiceBatchProjectRate.upsert({
        where: { invoiceBatchId_projectId: { invoiceBatchId: batchId, projectId } },
        create: { invoiceBatchId: batchId, projectId, hourlyRateCents },
        update: { hourlyRateCents },
      });
    }

    const updated = await this.getById(batchId);
    if (!updated) {
      // Kan in de praktijk niet voorkomen — de batch bestond net hierboven nog.
      throw InvoiceBatchErrors.notFound();
    }
    return updated;
  }

  /**
   * Klantvraag 10/9/2026 — "de klant wil ook nog een mogelijkheid om de
   * gefactureerde km en uren aan te passen vooraleer de factuur naar
   * teamleader gaat." Vult (of wist, met `null`) de correctie op één
   * werkbonregel van deze batch. Enkel toegestaan op een DRAFT-batch, zelfde
   * reden als setProjectRate hierboven: eens `invoices.draft` is
   * aangeroepen liggen de geprijsde regels al vast bij Teamleader. Wijzigt
   * bewust nooit `invoiceableSeconds`/`WorkOrder.kmAmountCents` zelf (de
   * bevroren, werkelijke waarden — business rule 3-analoog) — enkel deze
   * aparte override-kolommen, zodat de correctie zelf ook weer ongedaan
   * gemaakt kan worden vóór de conceptfactuur effectief aangemaakt wordt.
   */
  async setLineAdjustment(
    batchId: string,
    lineId: string,
    input: { adjustedInvoiceableSeconds: number | null; adjustedKmAmountCents: number | null; adjustmentNote: string | null },
  ): Promise<InvoiceBatchRecord> {
    const batch = await this.prisma.invoiceBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      throw InvoiceBatchErrors.notFound();
    }
    if (batch.status !== 'DRAFT') {
      throw InvoiceBatchErrors.alreadySubmittedToTeamleader();
    }
    const line = await this.prisma.invoiceBatchLine.findUnique({ where: { id: lineId } });
    if (!line || line.invoiceBatchId !== batchId) {
      throw InvoiceBatchErrors.lineNotOnBatch();
    }

    await this.prisma.invoiceBatchLine.update({
      where: { id: lineId },
      data: {
        adjustedInvoiceableSeconds: input.adjustedInvoiceableSeconds,
        adjustedKmAmountCents: input.adjustedKmAmountCents,
        adjustmentNote: input.adjustmentNote?.trim() || null,
      },
    });

    const updated = await this.getById(batchId);
    if (!updated) {
      // Kan in de praktijk niet voorkomen — de batch bestond net hierboven nog.
      throw InvoiceBatchErrors.notFound();
    }
    return updated;
  }

  /**
   * "Voorbereiden voor facturatie" (sectie 17). Valideert expliciet vóór het
   * aanmaken (in plaats van enkel op de databank-unique-constraint te
   * vertrouwen) zodat een admin een mensentaal-fout krijgt i.p.v. een kale
   * conflictmelding — de databank-kant (P2002 hieronder) blijft wel de
   * backstop tegen een race condition tussen twee gelijktijdige aanvragen.
   */
  async create(input: {
    customerId: string;
    periodLabel: string;
    workOrderIds: string[];
    createdByUserId: string;
  }): Promise<InvoiceBatchRecord> {
    if (input.workOrderIds.length === 0) {
      throw InvoiceBatchErrors.noWorkOrders();
    }

    const workOrders = (await this.prisma.workOrder.findMany({
      where: { id: { in: input.workOrderIds } },
      include: {
        project: { include: { customer: true } },
        timeEntries: { include: { timeEntry: true } },
        invoiceBatchLine: true,
      },
    })) as CreateBatchWorkOrderRow[];

    if (workOrders.length !== input.workOrderIds.length) {
      throw InvoiceBatchErrors.workOrderNotInvoiceable();
    }
    for (const workOrder of workOrders) {
      if (workOrder.status !== 'READY_FOR_INVOICING') {
        throw InvoiceBatchErrors.workOrderNotInvoiceable();
      }
      // Phase 12, deel C — backstop naast de listInvoiceable()-filter: een
      // werkbon van een nacalculatie-project (invoicingEnabled=false) mag
      // nooit in een batch belanden, ook niet via een rechtstreeks
      // meegegeven work-order-ID die de UI-filter omzeilt.
      if (!workOrder.project.invoicingEnabled) {
        throw InvoiceBatchErrors.workOrderNotInvoiceable();
      }
      if (workOrder.invoiceBatchLine) {
        throw InvoiceBatchErrors.workOrderAlreadyBatched();
      }
      if (workOrder.project.customerId !== input.customerId) {
        throw InvoiceBatchErrors.workOrderCustomerMismatch();
      }
    }

    const lines = workOrders.map((workOrder) => ({
      workOrderId: workOrder.id,
      invoiceableSeconds: workOrder.timeEntries.reduce((sum, link) => sum + computeWorkedSeconds(link.timeEntry), 0),
    }));
    const totalInvoiceableSeconds = lines.reduce((sum, line) => sum + line.invoiceableSeconds, 0);

    try {
      const created = (await this.prisma.invoiceBatch.create({
        data: {
          customerId: input.customerId,
          periodLabel: input.periodLabel,
          createdByUserId: input.createdByUserId,
          totalInvoiceableSeconds,
          lines: { create: lines },
        },
        ...WITH_BATCH_DETAILS,
      })) as RawBatch;
      return toBatchRecord(created);
    } catch (err) {
      // Backstop tegen een race condition: twee gelijktijdige "voorbereiden
      // voor facturatie"-aanvragen die dezelfde werkbon proberen te batchen
      // (zelfde patroon als WorkOrderService.create() bij P2002).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw InvoiceBatchErrors.workOrderAlreadyBatched();
      }
      throw err;
    }
  }

  /**
   * Verwijdert een per-ongeluk aangemaakte batch volledig (cascade verwijdert
   * de lines, wat de gekoppelde werkbonnen weer vrijgeeft voor een volgende
   * batch) — zie het commentaar bij InvoiceBatchLine in schema.prisma. Enkel
   * toegestaan op DRAFT: nog niet bereikbaar deze ronde, maar toekomstvast
   * zodra een echte Teamleader-indiening bestaat.
   */
  async remove(id: string): Promise<void> {
    const batch = await this.prisma.invoiceBatch.findUnique({ where: { id } });
    if (!batch) {
      throw InvoiceBatchErrors.notFound();
    }
    if (batch.status !== 'DRAFT') {
      throw InvoiceBatchErrors.cannotRemoveNonDraft();
    }
    await this.prisma.invoiceBatch.delete({ where: { id } });
  }
}

/** Zelfde formule als work-order-pdf-document.ts/time-tracking-sync.service.ts — bewust lokaal gehouden, zie de toelichting daar. */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

/** "2026-08" — maandnotatie voor het periodLabel-filter, zie listInvoiceable() hierboven. */
function periodLabelOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Zoals `InvoiceBatchRecord`, maar met de ruwe (nog niet-opgeloste) Prisma-vorm van `projectRates` — de vorm die `WITH_BATCH_DETAILS` effectief teruggeeft. */
type RawBatch = Omit<InvoiceBatchRecord, 'projectRates'> & BatchWithProjectDataRow;

function toBatchRecord(raw: RawBatch): InvoiceBatchRecord {
  return { ...raw, projectRates: resolveProjectRates(raw) };
}

/**
 * Klantvraag 10/9/2026 — bepaalt, voor elk project dat op minstens één
 * werkbon van deze batch voorkomt, het tarief waarmee de uren geprijsd
 * worden: de eenmalige override op déze batch (InvoiceBatchProjectRate)
 * heeft voorrang op het standaardtarief uit de projectinstellingen
 * (Project.hourlyRateCents). `effectiveHourlyRateCents: null` betekent dat
 * er voor dat project nog geen van beide is ingevuld.
 */
function resolveProjectRates(batch: BatchWithProjectDataRow): InvoiceBatchProjectRateRecord[] {
  const overrideByProjectId = new Map(batch.projectRates.map((rate) => [rate.projectId, rate.hourlyRateCents]));
  const projectById = new Map<string, { name: string; hourlyRateCents: number | null }>();
  for (const line of batch.lines) {
    const project = line.workOrder.project;
    projectById.set(project.id, { name: project.name, hourlyRateCents: project.hourlyRateCents });
  }

  return Array.from(projectById.entries())
    .map(([projectId, info]) => {
      const overrideHourlyRateCents = overrideByProjectId.get(projectId) ?? null;
      return {
        projectId,
        projectName: info.name,
        defaultHourlyRateCents: info.hourlyRateCents,
        overrideHourlyRateCents,
        effectiveHourlyRateCents: overrideHourlyRateCents ?? info.hourlyRateCents,
      };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}
