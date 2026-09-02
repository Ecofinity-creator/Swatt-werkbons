import type { PrismaClient } from '@prisma/client';
import { HoursExportErrors } from '../../errors';
import { allocateHoursAcrossEntries } from '../rates/rate-calculation.service';

/**
 * Werknemer vs. Onderaannemer — maandelijkse uren-export (backlog-item 30/8,
 * zie claude/projectoverdracht-samenvatting_2.md sectie 3.3). Dezelfde
 * onderliggende urendata als het bestaande facturatie-overzicht
 * (InvoiceBatchService), maar hier bewust NIET beperkt tot werkbonnen die al
 * dan niet in een InvoiceBatch zitten — dit overzicht is "los van de
 * facturatie-toggle" (zie Fase 12 Deel C in de projectdocumentatie): een
 * medewerker/onderaannemer moet uitbetaald/gefactureerd kunnen worden
 * ongeacht of de bijhorende werkbon (nog) lokaal gefactureerd is.
 *
 * Enige voorwaarde: de gekoppelde werkbon moet ondertekend zijn
 * (`signature` niet null) — een niet-ondertekende werkbon is nog geen
 * definitieve, betrouwbare urenregistratie (sectie 11).
 *
 * Op vraag (1/9/2026): het onderaannemersdocument toont per registratie ook
 * de overuren-splitsing (normaal/overuren), niet enkel het totaal — zelfde
 * bucket-per-dag/week-logica als PayrollService.computeLinesForEmployee(),
 * hier bewust lokaal opnieuw toegepast (geen gedeelde helper, om
 * HoursExportService niet afhankelijk te maken van PayrollService se
 * bevroren-batch-semantiek — dit overzicht herberekent altijd vers).
 */
export class HoursExportService {
  constructor(private readonly prisma: PrismaClient) {}

  async listOverview(periodLabel: string): Promise<HoursExportEmployeeRecord[]> {
    assertValidPeriod(periodLabel);
    const employees = await this.loadEmployeesWithSignedEntries(periodLabel);
    return employees.map((employee) => ({
      employeeId: employee.id,
      displayName: employee.displayName,
      employmentType: employee.employmentType,
      totalSeconds: employee.entries.reduce((sum, entry) => sum + computeWorkedSeconds(entry), 0),
      workOrderCount: new Set(employee.entries.map((entry) => entry.workOrderLink.workOrder.id)).size,
    }));
  }

  /** Ruwe, ongegroepeerde urenlijst voor de gedeelde Excel-export (EMPLOYEE). */
  async listEntriesForEmployees(periodLabel: string): Promise<HoursExportEmployeeDetail[]> {
    assertValidPeriod(periodLabel);
    const employees = await this.loadEmployeesWithSignedEntries(periodLabel);
    return employees
      .filter((employee) => employee.employmentType === 'EMPLOYEE')
      .map((employee) => ({
        employeeId: employee.id,
        displayName: employee.displayName,
        entries: this.splitOvertimePerProject(employee.entries)
          .map(toEntryRecord)
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Totalisatie-met-detail (gegroepeerd per project/werf) voor het PDF-document van één onderaannemer. */
  async getSubcontractorDetail(employeeId: string, periodLabel: string): Promise<HoursExportSubcontractorDetail> {
    assertValidPeriod(periodLabel);
    const employees = await this.loadEmployeesWithSignedEntries(periodLabel, employeeId);
    const employee = employees[0];
    if (!employee) {
      throw HoursExportErrors.employeeNotFound();
    }
    if (employee.employmentType !== 'SUBCONTRACTOR') {
      throw HoursExportErrors.wrongEmploymentType('Onderaannemer');
    }

    const entries = this.splitOvertimePerProject(employee.entries).map(toEntryRecord);
    const projectsByKey = new Map<string, HoursExportProjectGroup>();
    for (const entry of entries) {
      const key = `${entry.projectName}::${entry.projectNumber ?? ''}`;
      const existing = projectsByKey.get(key);
      if (existing) {
        existing.entries.push(entry);
        existing.totalSeconds += computeWorkedSeconds(entry);
        existing.totalNormalHours += entry.normalHours;
        existing.totalOvertimeHours += entry.overtimeHours;
      } else {
        projectsByKey.set(key, {
          projectName: entry.projectName,
          projectNumber: entry.projectNumber,
          customerName: entry.customerName,
          entries: [entry],
          totalSeconds: computeWorkedSeconds(entry),
          totalNormalHours: entry.normalHours,
          totalOvertimeHours: entry.overtimeHours,
        });
      }
    }
    const projects = Array.from(projectsByKey.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
    for (const project of projects) {
      project.entries.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    }

    return {
      employeeId: employee.id,
      displayName: employee.displayName,
      periodLabel,
      projects,
      totalSeconds: projects.reduce((sum, project) => sum + project.totalSeconds, 0),
      totalNormalHours: round2(projects.reduce((sum, project) => sum + project.totalNormalHours, 0)),
      totalOvertimeHours: round2(projects.reduce((sum, project) => sum + project.totalOvertimeHours, 0)),
    };
  }

  /**
   * Verdeelt elke tijdregistratie in normale uren/overuren, gegroepeerd per
   * project en per dag/week naargelang de overurenregeling van dat project
   * (zie Project.overtimeThresholdType, Fase 12-herziening: uniform per
   * project). Wanneer overuren niet van toepassing is op een project, blijft
   * alles "normaal" (overtimeHours = 0) — zelfde aanpak als
   * PayrollService.computeLinesForEmployee().
   */
  private splitOvertimePerProject(entries: SignedEntryRow[]): SignedEntryRowWithSplit[] {
    const byProject = new Map<string, SignedEntryRow[]>();
    for (const entry of entries) {
      const projectId = entry.workOrderLink.workOrder.project.id;
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId)!.push(entry);
    }

    const result: SignedEntryRowWithSplit[] = [];
    for (const [, projectEntries] of byProject) {
      const project = projectEntries[0]!.workOrderLink.workOrder.project;
      if (!project.overtimeApplies) {
        for (const entry of projectEntries) {
          result.push({ ...entry, normalHours: round2(computeWorkedSeconds(entry) / 3600), overtimeHours: 0 });
        }
        continue;
      }

      const periodKeyOf = (entry: SignedEntryRow) =>
        project.overtimeThresholdType === 'DAILY' ? dayKeyOf(entry.startedAt) : isoWeekKeyOf(entry.startedAt);
      const byPeriod = new Map<string, SignedEntryRow[]>();
      for (const entry of projectEntries) {
        const key = periodKeyOf(entry);
        if (!byPeriod.has(key)) byPeriod.set(key, []);
        byPeriod.get(key)!.push(entry);
      }

      for (const [, periodEntries] of byPeriod) {
        const sorted = [...periodEntries].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
        const hoursById = sorted.map((entry, index) => ({ id: String(index), hours: computeWorkedSeconds(entry) / 3600 }));
        const split = allocateHoursAcrossEntries(hoursById, {
          overtimeThresholdType: project.overtimeThresholdType,
          overtimeWeeklyThresholdHours: project.overtimeWeeklyThresholdHours === null ? null : Number(project.overtimeWeeklyThresholdHours),
        });
        sorted.forEach((entry, index) => {
          const { normalHours, overtimeHours } = split.get(String(index))!;
          result.push({ ...entry, normalHours: round2(normalHours), overtimeHours: round2(overtimeHours) });
        });
      }
    }
    return result;
  }

  /**
   * Handgeschreven vorm van de query hieronder — zelfde reden als elders in
   * deze codebase (mogelijk stale gegenereerde Prisma-client in de sandbox,
   * zie de toelichting in invoice-batch.service.ts). `employeeId` filtert
   * optioneel op één medewerker (gebruikt door getSubcontractorDetail()).
   */
  private async loadEmployeesWithSignedEntries(
    periodLabel: string,
    employeeId?: string,
  ): Promise<EmployeeWithSignedEntriesRow[]> {
    const employees = (await this.prisma.employee.findMany({
      where: employeeId ? { id: employeeId } : {},
      select: {
        id: true,
        displayName: true,
        employmentType: true,
        timeEntries: {
          where: { endedAt: { not: null } },
          select: {
            startedAt: true,
            endedAt: true,
            pausedSeconds: true,
            isManual: true,
            description: true,
            workOrderLink: {
              select: {
                workOrder: {
                  select: {
                    id: true,
                    workOrderNumber: true,
                    project: {
                      select: {
                        id: true,
                        name: true,
                        projectNumber: true,
                        customer: { select: { name: true } },
                        overtimeApplies: true,
                        overtimeThresholdType: true,
                        overtimeWeeklyThresholdHours: true,
                      },
                    },
                    signature: { select: { signedAt: true } },
                  },
                },
              },
            },
          },
        },
      },
    })) as unknown as EmployeeWithSignedEntriesRow[];

    return employees.map((employee) => ({
      ...employee,
      entries: employee.timeEntries.filter((entry): entry is SignedEntryRow => {
        const signedAt = entry.workOrderLink?.workOrder.signature?.signedAt;
        return signedAt != null && periodLabelOf(signedAt) === periodLabel;
      }),
    }));
  }
}

export interface HoursExportEmployeeRecord {
  employeeId: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  totalSeconds: number;
  workOrderCount: number;
}

export interface HoursExportEntryRecord {
  workOrderId: string;
  workOrderNumber: string;
  projectName: string;
  projectNumber: string | null;
  customerName: string;
  signedAt: Date;
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
  isManual: boolean;
  description: string | null;
  /** Fase 12-herziening: overuren-splitsing, zie splitOvertimePerProject() hierboven. */
  normalHours: number;
  overtimeHours: number;
}

export interface HoursExportEmployeeDetail {
  employeeId: string;
  displayName: string;
  entries: HoursExportEntryRecord[];
}

export interface HoursExportProjectGroup {
  projectName: string;
  projectNumber: string | null;
  customerName: string;
  entries: HoursExportEntryRecord[];
  totalSeconds: number;
  totalNormalHours: number;
  totalOvertimeHours: number;
}

export interface HoursExportSubcontractorDetail {
  employeeId: string;
  displayName: string;
  periodLabel: string;
  projects: HoursExportProjectGroup[];
  totalSeconds: number;
  totalNormalHours: number;
  totalOvertimeHours: number;
}

interface WorkOrderLinkRow {
  workOrder: {
    id: string;
    workOrderNumber: string;
    project: {
      id: string;
      name: string;
      projectNumber: string | null;
      customer: { name: string };
      overtimeApplies: boolean;
      overtimeThresholdType: 'DAILY' | 'WEEKLY';
      overtimeWeeklyThresholdHours: number | null;
    };
    signature: { signedAt: Date } | null;
  };
}

interface TimeEntryRow {
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  isManual: boolean;
  description: string | null;
  workOrderLink: WorkOrderLinkRow | null;
}

interface SignedEntryRow extends TimeEntryRow {
  endedAt: Date;
  workOrderLink: WorkOrderLinkRow;
}

/** Tussenvorm ná splitOvertimePerProject() — zelfde velden als SignedEntryRow plus de berekende splitsing. */
interface SignedEntryRowWithSplit extends SignedEntryRow {
  normalHours: number;
  overtimeHours: number;
}

interface EmployeeWithSignedEntriesRow {
  id: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  timeEntries: TimeEntryRow[];
  /** Toegevoegd door loadEmployeesWithSignedEntries() — enkel de tijdregistraties binnen de opgevraagde periode, op een ondertekende werkbon. */
  entries: SignedEntryRow[];
}

function toEntryRecord(entry: SignedEntryRowWithSplit): HoursExportEntryRecord {
  const workOrder = entry.workOrderLink.workOrder;
  return {
    workOrderId: workOrder.id,
    workOrderNumber: workOrder.workOrderNumber,
    projectName: workOrder.project.name,
    projectNumber: workOrder.project.projectNumber,
    customerName: workOrder.project.customer.name,
    // signature is gegarandeerd niet-null op dit punt (zie loadEmployeesWithSignedEntries() se filter hierboven).
    signedAt: workOrder.signature!.signedAt,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    pausedSeconds: entry.pausedSeconds,
    isManual: entry.isManual,
    description: entry.description,
    normalHours: entry.normalHours,
    overtimeHours: entry.overtimeHours,
  };
}

/** Zelfde formule als work-order-pdf-document.ts/invoice-batch.service.ts — bewust lokaal gehouden, zie de toelichting daar. */
function computeWorkedSeconds(entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number }): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

/** "2026-08" — zelfde notatie/formule als periodLabelOf() in invoice-batch.service.ts. */
function periodLabelOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO-8601-weeknummer (maandag als eerste dag) — zelfde implementatie als teamleader-invoice.service.ts/payroll.service.ts (bewust lokaal gehouden, zie de toelichting daar). */
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

const PERIOD_LABEL_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidPeriod(periodLabel: string): void {
  if (!PERIOD_LABEL_RE.test(periodLabel)) {
    throw HoursExportErrors.invalidPeriod();
  }
}
