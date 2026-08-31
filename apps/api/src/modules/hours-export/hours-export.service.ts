import type { PrismaClient } from '@prisma/client';
import { HoursExportErrors } from '../../errors';

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
        entries: employee.entries.map(toEntryRecord).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
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

    const entries = employee.entries.map(toEntryRecord);
    const projectsByKey = new Map<string, HoursExportProjectGroup>();
    for (const entry of entries) {
      const key = `${entry.projectName}::${entry.projectNumber ?? ''}`;
      const existing = projectsByKey.get(key);
      if (existing) {
        existing.entries.push(entry);
        existing.totalSeconds += computeWorkedSeconds(entry);
      } else {
        projectsByKey.set(key, {
          projectName: entry.projectName,
          projectNumber: entry.projectNumber,
          customerName: entry.customerName,
          entries: [entry],
          totalSeconds: computeWorkedSeconds(entry),
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
    };
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
                        name: true,
                        projectNumber: true,
                        customer: { select: { name: true } },
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
}

export interface HoursExportSubcontractorDetail {
  employeeId: string;
  displayName: string;
  periodLabel: string;
  projects: HoursExportProjectGroup[];
  totalSeconds: number;
}

interface WorkOrderLinkRow {
  workOrder: {
    id: string;
    workOrderNumber: string;
    project: { name: string; projectNumber: string | null; customer: { name: string } };
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

interface EmployeeWithSignedEntriesRow {
  id: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  timeEntries: TimeEntryRow[];
  /** Toegevoegd door loadEmployeesWithSignedEntries() — enkel de tijdregistraties binnen de opgevraagde periode, op een ondertekende werkbon. */
  entries: SignedEntryRow[];
}

function toEntryRecord(entry: SignedEntryRow): HoursExportEntryRecord {
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

const PERIOD_LABEL_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidPeriod(periodLabel: string): void {
  if (!PERIOD_LABEL_RE.test(periodLabel)) {
    throw HoursExportErrors.invalidPeriod();
  }
}
