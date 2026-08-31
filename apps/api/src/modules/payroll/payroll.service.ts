import { Prisma, type PrismaClient } from '@prisma/client';
import { PayrollErrors } from '../../errors';
import { allocateHoursAcrossEntries, computeRatePercent } from '../rates/rate-calculation.service';

/**
 * Phase 12, deel E — "Personeelsuitbetaling": maandoverzicht per medewerker
 * met exact dezelfde rekenlogica als de klantfactuur (RateCalculationService,
 * zie teamleader-invoice.service.ts), maar bewust losgekoppeld van
 * InvoiceBatch/Project.invoicingEnabled — een medewerker wordt uitbetaald
 * voor elke gewerkte, ondertekende uur, ook op een nacalculatie-project
 * (Phase 12, deel C) zonder klantfactuur.
 *
 * "Betaalbaar" = een tijdregistratie die aan een ondertekende werkbon hangt
 * (`WorkOrderSignature` bestaat — business rule 3: pas dan zijn de uren
 * definitief) en nog niet in een `PayrollBatchLine` zit (business rule 12).
 */

interface PayableTimeEntryRow {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  employeeId: string;
  projectId: string;
  employee: {
    id: string;
    displayName: string;
    defaultHourlyRateCents: number | null;
    overtimeRatePercent: number;
    shiftWorkRatePercent: number;
    nightWorkRatePercent: number;
  };
  project: {
    id: string;
    name: string;
    overtimeThresholdType: 'DAILY' | 'WEEKLY';
    overtimeWeeklyThresholdHours: Prisma.Decimal | number | null;
  };
  workOrderLink: { workOrder: { signature: { signedAt: Date } | null } } | null;
}

interface ProjectAssignmentRow {
  employeeId: string;
  projectId: string;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
}

export interface PayableEmployeeSummary {
  employeeId: string;
  displayName: string;
  normalHours: number;
  overtimeHours: number;
  shiftHours: number;
  nightHours: number;
  /** `null` zolang deze medewerker geen `defaultHourlyRateCents` heeft (zie UserDetailPage) — kan dan wel getoond, maar niet in een batch omgezet worden. */
  totalAmountCents: number | null;
}

export interface PayrollBatchLineRecord {
  id: string;
  timeEntryId: string;
  projectName: string;
  normalHours: number;
  overtimeHours: number;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  amountCents: number;
}

export interface PayrollBatchRecord {
  id: string;
  employeeId: string;
  employeeDisplayName: string;
  periodLabel: string;
  status: 'DRAFT' | 'CLOSED';
  totalAmountCents: number;
  createdAt: Date;
  closedAt: Date | null;
  lines: PayrollBatchLineRecord[];
}

const WITH_LINES_DETAILS = {
  include: {
    employee: true,
    lines: { include: { timeEntry: { include: { project: true } } } },
  },
} as const;

export class PayrollService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Overzicht over ALLE medewerkers heen voor een gekozen periode (of alles,
   * als geen periode meegegeven is) — de "Personeelsuitbetaling"-pagina toont
   * dit als tabel, één rij per medewerker, net als het bestaande
   * Facturatie-overzicht (Phase 10) dat per klant doet.
   */
  async listPayableSummary(periodLabel?: string): Promise<PayableEmployeeSummary[]> {
    const entries = await this.fetchPayableEntries({});
    const filtered = periodLabel ? entries.filter((entry) => periodLabelOf(this.signedAtOf(entry)) === periodLabel) : entries;
    const assignments = await this.fetchAssignmentsFor(Array.from(new Set(filtered.map((entry) => entry.employeeId))));

    const perEmployeeEntries = groupBy(filtered, (entry) => entry.employeeId);
    const summaries: PayableEmployeeSummary[] = [];
    for (const [employeeId, employeeEntries] of perEmployeeEntries) {
      const employee = employeeEntries[0]!.employee;
      const lines = computeLinesForEmployee(employeeEntries, assignments);
      const totalAmountCents = employee.defaultHourlyRateCents === null ? null : lines.reduce((sum, line) => sum + line.amountCents, 0);
      summaries.push({
        employeeId,
        displayName: employee.displayName,
        normalHours: round2(lines.reduce((sum, line) => sum + line.normalHours, 0)),
        overtimeHours: round2(lines.reduce((sum, line) => sum + line.overtimeHours, 0)),
        shiftHours: round2(lines.filter((line) => line.premiumType === 'SHIFT_WORK').reduce((sum, line) => sum + line.normalHours + line.overtimeHours, 0)),
        nightHours: round2(lines.filter((line) => line.premiumType === 'NIGHT_WORK').reduce((sum, line) => sum + line.normalHours + line.overtimeHours, 0)),
        totalAmountCents,
      });
    }
    return summaries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Maakt de personeelsuitbetaling effectief aan voor één medewerker/periode
   * — herberekent op dit moment (niet op basis van listPayableSummary's
   * momentopname) om een race condition met een ondertussen gewijzigde
   * koppeling/tarief te vermijden, en valideert vóór aanmaak vs. de
   * unique-constraint-backstop (zelfde P2002-patroon als InvoiceBatchService).
   */
  async createBatch(employeeId: string, periodLabel: string, createdByUserId: string): Promise<PayrollBatchRecord> {
    const entries = (await this.fetchPayableEntries({ employeeId })).filter((entry) => periodLabelOf(this.signedAtOf(entry)) === periodLabel);
    if (entries.length === 0) {
      throw PayrollErrors.noTimeEntries();
    }

    const employee = entries[0]!.employee;
    if (employee.defaultHourlyRateCents === null) {
      throw PayrollErrors.employeeHourlyRateNotSet(employee.displayName);
    }

    const assignments = await this.fetchAssignmentsFor([employeeId]);
    const lines = computeLinesForEmployee(entries, assignments);
    const totalAmountCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

    try {
      const created = await this.prisma.payrollBatch.create({
        data: {
          employeeId,
          periodLabel,
          createdByUserId,
          totalAmountCents,
          lines: {
            create: lines.map((line) => ({
              timeEntryId: line.timeEntryId,
              normalHours: line.normalHours,
              overtimeHours: line.overtimeHours,
              premiumType: line.premiumType,
              amountCents: line.amountCents,
            })),
          },
        },
        ...WITH_LINES_DETAILS,
      });
      return toBatchRecord(created);
    } catch (err) {
      // Backstop tegen een race condition: twee gelijktijdige aanmaakverzoeken
      // voor dezelfde medewerker/periode die (deels) dezelfde uren bevatten
      // (business rule 12) — zelfde P2002-patroon als InvoiceBatchService.create().
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw PayrollErrors.timeEntryAlreadyPaid();
      }
      throw err;
    }
  }

  async list(filters: { employeeId?: string | undefined; periodLabel?: string | undefined } = {}): Promise<PayrollBatchRecord[]> {
    const batches = await this.prisma.payrollBatch.findMany({
      where: {
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.periodLabel ? { periodLabel: filters.periodLabel } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...WITH_LINES_DETAILS,
    });
    return batches.map(toBatchRecord);
  }

  /** Enkel op DRAFT (nog niet CLOSED) — zelfde regel als InvoiceBatchService.remove(). Cascade geeft de tijdregistraties meteen weer vrij. */
  async remove(id: string): Promise<void> {
    const batch = await this.prisma.payrollBatch.findUnique({ where: { id } });
    if (!batch) {
      throw PayrollErrors.notFound();
    }
    if (batch.status !== 'DRAFT') {
      throw PayrollErrors.cannotRemoveNonDraft();
    }
    await this.prisma.payrollBatch.delete({ where: { id } });
  }

  private async fetchPayableEntries(filters: { employeeId?: string }): Promise<PayableTimeEntryRow[]> {
    return (await this.prisma.timeEntry.findMany({
      where: {
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        payrollLine: null,
        workOrderLink: { workOrder: { signature: { isNot: null } } },
      },
      include: {
        employee: true,
        project: true,
        workOrderLink: { include: { workOrder: { include: { signature: true } } } },
      },
      orderBy: { startedAt: 'asc' },
    })) as unknown as PayableTimeEntryRow[];
  }

  private async fetchAssignmentsFor(employeeIds: string[]): Promise<ProjectAssignmentRow[]> {
    if (employeeIds.length === 0) return [];
    return (await this.prisma.projectAssignment.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true, projectId: true, overtimeApplies: true, premiumType: true },
    })) as ProjectAssignmentRow[];
  }

  private signedAtOf(entry: PayableTimeEntryRow): Date {
    // Kan in de praktijk niet ontbreken — de where-clausule in fetchPayableEntries
    // sluit entries zonder handtekening al uit — defensief niet-null hier.
    return entry.workOrderLink!.workOrder.signature!.signedAt;
  }
}

interface ComputedLine {
  timeEntryId: string;
  projectName: string;
  normalHours: number;
  overtimeHours: number;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  amountCents: number;
}

/**
 * Bouwt de betaalregels voor één medewerker op: groepeert diens registraties
 * per project, bucket per dag/week (naargelang het project), verdeelt de
 * overuren-splitsing terug over de individuele registraties
 * (allocateHoursAcrossEntries — dit is precies waarom deel E een aparte
 * functie nodig had t.o.v. de per-batch-aggregatie in
 * teamleader-invoice.service.ts, die geen regel-per-brontijdregistratie
 * hoeft te bewaren), en past per registratie het toeslagpercentage toe.
 */
function computeLinesForEmployee(entries: PayableTimeEntryRow[], assignments: ProjectAssignmentRow[]): ComputedLine[] {
  const assignmentByProjectId = new Map(assignments.map((a) => [a.projectId, a]));
  const entriesByProject = groupBy(entries, (entry) => entry.projectId);

  const lines: ComputedLine[] = [];
  for (const [, projectEntries] of entriesByProject) {
    const project = projectEntries[0]!.project;
    const employee = projectEntries[0]!.employee;
    const assignment: ProjectAssignmentRow = assignmentByProjectId.get(project.id) ?? {
      employeeId: employee.id,
      projectId: project.id,
      overtimeApplies: false,
      premiumType: 'NONE',
    };
    const { normalPercent, overtimePercent } = computeRatePercent(employee, assignment);
    const baseRateCents = employee.defaultHourlyRateCents ?? 0;

    const periodKeyOf = (entry: PayableTimeEntryRow) =>
      project.overtimeThresholdType === 'DAILY' ? dayKeyOf(entry.startedAt) : isoWeekKeyOf(entry.startedAt);
    const entriesByPeriod = groupBy(projectEntries, periodKeyOf);

    for (const [, periodEntries] of entriesByPeriod) {
      const sorted = [...periodEntries].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const hoursById = sorted.map((entry) => ({ id: entry.id, hours: computeWorkedSeconds(entry) / 3600 }));
      const split = assignment.overtimeApplies
        ? allocateHoursAcrossEntries(hoursById, {
            overtimeThresholdType: project.overtimeThresholdType,
            overtimeWeeklyThresholdHours: project.overtimeWeeklyThresholdHours === null ? null : Number(project.overtimeWeeklyThresholdHours),
          })
        : new Map(hoursById.map((h) => [h.id, { normalHours: h.hours, overtimeHours: 0 }]));

      for (const entry of sorted) {
        const { normalHours, overtimeHours } = split.get(entry.id)!;
        const amountCents = Math.round(normalHours * baseRateCents * (normalPercent / 100) + overtimeHours * baseRateCents * (overtimePercent / 100));
        lines.push({
          timeEntryId: entry.id,
          projectName: project.name,
          normalHours: round2(normalHours),
          overtimeHours: round2(overtimeHours),
          premiumType: assignment.premiumType,
          amountCents,
        });
      }
    }
  }
  return lines;
}

function toBatchRecord(batch: {
  id: string;
  employeeId: string;
  employee: { displayName: string };
  periodLabel: string;
  status: string;
  totalAmountCents: number;
  createdAt: Date;
  closedAt: Date | null;
  lines: Array<{
    id: string;
    timeEntryId: string;
    normalHours: Prisma.Decimal | number;
    overtimeHours: Prisma.Decimal | number;
    premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
    amountCents: number;
    timeEntry: { project: { name: string } };
  }>;
}): PayrollBatchRecord {
  return {
    id: batch.id,
    employeeId: batch.employeeId,
    employeeDisplayName: batch.employee.displayName,
    periodLabel: batch.periodLabel,
    status: batch.status as 'DRAFT' | 'CLOSED',
    totalAmountCents: batch.totalAmountCents,
    createdAt: batch.createdAt,
    closedAt: batch.closedAt,
    lines: batch.lines.map((line) => ({
      id: line.id,
      timeEntryId: line.timeEntryId,
      projectName: line.timeEntry.project.name,
      normalHours: Number(line.normalHours),
      overtimeHours: Number(line.overtimeHours),
      premiumType: line.premiumType,
      amountCents: line.amountCents,
    })),
  };
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Zelfde formule als elders in de codebase (invoice-batch.service.ts, teamleader-invoice.service.ts, ...) — bewust lokaal gehouden, zie de toelichting daar. */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

/** "YYYY-MM" — zelfde patroon als periodLabelOf() in invoice-batch.service.ts. */
function periodLabelOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO-8601-weeknummer (maandag als eerste dag) — zelfde implementatie als teamleader-invoice.service.ts (bewust lokaal gehouden, zie de toelichting daar). */
function isoWeekKeyOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNumber + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNumber + 3);
  const weekNumber = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}
