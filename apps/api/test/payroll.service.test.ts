import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PayrollService } from '../src/modules/payroll/payroll.service';

/**
 * Unit-tests voor de personeelsuitbetaling (Phase 12, deel E) — met een
 * handgeschreven fake-Prisma, zelfde patroon als invoice-batch.service.test.ts.
 * `payrollLine`/"al betaald" wordt afgeleid uit de aangemaakte batches zelf
 * (niet een los bij te houden veld), zodat business rule 12 ("elke
 * tijdregistratie mag maar één keer uitbetaald worden") realistisch getest
 * wordt — aanmaken van een batch maakt de tijdregistratie meteen onbeschikbaar
 * voor een volgende listPayableSummary()/createBatch().
 */

interface FakeEmployee {
  id: string;
  displayName: string;
  defaultHourlyRateCents: number | null;
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
}

interface FakeProject {
  id: string;
  name: string;
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  overtimeWeeklyThresholdHours: number | null;
}

interface FakeAssignment {
  employeeId: string;
  projectId: string;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
}

interface FakeTimeEntry {
  id: string;
  employeeId: string;
  projectId: string;
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  signed: boolean; // vervangt workOrderLink.workOrder.signature — enkel signed=true is "betaalbaar"
}

function createFakePrisma(opts: { employees: FakeEmployee[]; projects: FakeProject[]; assignments: FakeAssignment[]; entries: FakeTimeEntry[] }) {
  const { employees, projects, assignments, entries } = opts;
  const batches = new Map<string, { id: string; employeeId: string; periodLabel: string; status: string; totalAmountCents: number; createdByUserId: string; createdAt: Date; closedAt: Date | null }>();
  const lines = new Map<string, { id: string; payrollBatchId: string; timeEntryId: string; normalHours: number; overtimeHours: number; premiumType: string; amountCents: number }>();
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  function paidTimeEntryIds(): Set<string> {
    return new Set(Array.from(lines.values()).map((l) => l.timeEntryId));
  }

  function hydrate(id: string) {
    const batch = batches.get(id);
    if (!batch) throw new Error('batch niet gevonden');
    const employee = employees.find((e) => e.id === batch.employeeId)!;
    const batchLines = Array.from(lines.values()).filter((l) => l.payrollBatchId === id);
    return {
      ...batch,
      employee: { displayName: employee.displayName },
      lines: batchLines.map((l) => {
        const entry = entries.find((e) => e.id === l.timeEntryId)!;
        const project = projects.find((p) => p.id === entry.projectId)!;
        return { ...l, timeEntry: { project: { name: project.name } } };
      }),
    };
  }

  const prisma = {
    timeEntry: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const paid = paidTimeEntryIds();
        const employeeId = where.employeeId as string | undefined;
        return entries
          .filter((e) => e.signed && !paid.has(e.id) && (!employeeId || e.employeeId === employeeId))
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
          .map((e) => ({
            id: e.id,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            pausedSeconds: e.pausedSeconds,
            employeeId: e.employeeId,
            projectId: e.projectId,
            employee: employees.find((emp) => emp.id === e.employeeId),
            project: projects.find((p) => p.id === e.projectId),
            workOrderLink: { workOrder: { signature: { signedAt: e.startedAt } } },
          }));
      },
    },
    projectAssignment: {
      findMany: async ({ where }: { where: { employeeId: { in: string[] } } }) =>
        assignments.filter((a) => where.employeeId.in.includes(a.employeeId)),
    },
    payrollBatch: {
      create: async ({ data }: { data: { employeeId: string; periodLabel: string; createdByUserId: string; totalAmountCents: number; lines: { create: Array<{ timeEntryId: string; normalHours: number; overtimeHours: number; premiumType: string; amountCents: number }> } } }) => {
        const paid = paidTimeEntryIds();
        for (const line of data.lines.create) {
          if (paid.has(line.timeEntryId)) {
            const err = new Error('Unique constraint failed') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
        }
        const id = genId('batch');
        batches.set(id, {
          id,
          employeeId: data.employeeId,
          periodLabel: data.periodLabel,
          status: 'DRAFT',
          totalAmountCents: data.totalAmountCents,
          createdByUserId: data.createdByUserId,
          createdAt: new Date(),
          closedAt: null,
        });
        for (const line of data.lines.create) {
          const lineId = genId('line');
          lines.set(lineId, { id: lineId, payrollBatchId: id, ...line });
        }
        return hydrate(id);
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        Array.from(batches.values())
          .filter((b) => (where.employeeId ? b.employeeId === where.employeeId : true))
          .filter((b) => (where.periodLabel ? b.periodLabel === where.periodLabel : true))
          .map((b) => hydrate(b.id)),
      findUnique: async ({ where }: { where: { id: string } }) => (batches.has(where.id) ? { ...batches.get(where.id)! } : null),
      delete: async ({ where }: { where: { id: string } }) => {
        batches.delete(where.id);
        for (const [lineId, line] of lines) {
          if (line.payrollBatchId === where.id) lines.delete(lineId);
        }
      },
    },
  };

  return { prisma: prisma as unknown as PrismaClient };
}

const peter: FakeEmployee = { id: 'emp-peter', displayName: 'Peter Janssens', defaultHourlyRateCents: 6500, overtimeRatePercent: 150, shiftWorkRatePercent: 120, nightWorkRatePercent: 150 };
const projectNormal: FakeProject = { id: 'proj-normal', name: 'Onderhoud HVAC (gefactureerd)', overtimeThresholdType: 'DAILY', overtimeWeeklyThresholdHours: null };
const projectNacalc: FakeProject = { id: 'proj-nacalc', name: 'Interne renovatie (nacalculatie)', overtimeThresholdType: 'DAILY', overtimeWeeklyThresholdHours: null };

describe('PayrollService', () => {
  it('listPayableSummary() telt uren van een gewoon EN een nacalculatie-project even hard mee', async () => {
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, signed: true },
      { id: 'te-2', employeeId: peter.id, projectId: projectNacalc.id, startedAt: new Date('2026-08-11T08:00:00Z'), endedAt: new Date('2026-08-11T10:00:00Z'), pausedSeconds: 0, signed: true },
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal, projectNacalc], assignments: [], entries });
    const service = new PayrollService(prisma);

    const summary = await service.listPayableSummary('2026-08');

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ employeeId: peter.id, normalHours: 4, overtimeHours: 0, totalAmountCents: 4 * 6500 });
  });

  it('splitst overuren correct binnen één DAILY-project (9u30 → 8u normaal + 1u30 overuren)', async () => {
    const assignments: FakeAssignment[] = [{ employeeId: peter.id, projectId: projectNormal.id, overtimeApplies: true, premiumType: 'NONE' }];
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T07:00:00Z'), endedAt: new Date('2026-08-10T16:30:00Z'), pausedSeconds: 0, signed: true },
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments, entries });
    const service = new PayrollService(prisma);

    const summary = await service.listPayableSummary('2026-08');

    expect(summary[0]).toMatchObject({
      normalHours: 8,
      overtimeHours: 1.5,
      totalAmountCents: Math.round(8 * 6500 + 1.5 * 6500 * 1.5),
    });
  });

  it('createBatch(): het bedrag komt overeen met wat voor dezelfde uren aan de klant zou worden aangerekend (nachtwerk+overuren = 200%)', async () => {
    const assignments: FakeAssignment[] = [{ employeeId: peter.id, projectId: projectNormal.id, overtimeApplies: true, premiumType: 'NIGHT_WORK' }];
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T06:00:00Z'), endedAt: new Date('2026-08-10T16:00:00Z'), pausedSeconds: 0, signed: true }, // 10u
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments, entries });
    const service = new PayrollService(prisma);

    const batch = await service.createBatch(peter.id, '2026-08', 'user-admin');

    // 8u @150% (nachtwerk) + 2u @200% (nachtwerk+overuren) = 8*6500*1.5 + 2*6500*2.0
    expect(batch.totalAmountCents).toBe(Math.round(8 * 6500 * 1.5 + 2 * 6500 * 2.0));
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0]?.projectName).toBe(projectNormal.name);
  });

  it('business rule 12: dezelfde tijdregistratie kan niet tweemaal uitbetaald worden', async () => {
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, signed: true },
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments: [], entries });
    const service = new PayrollService(prisma);

    await service.createBatch(peter.id, '2026-08', 'user-admin');

    expect(await service.listPayableSummary('2026-08')).toHaveLength(0);
    // Een tweede aanmaakpoging vindt geen enkele betaalbare uur meer (al opgenomen
    // in de eerste batch) — dit is precies hoe business rule 12 hier afgedwongen
    // wordt bij een normale, sequentiële herhaalde klik. De P2002-backstop in
    // createBatch() vangt enkel de zeldzame échte race condition op (twee
    // gelijktijdige aanmaakpogingen die allebei vóór elkaars schrijfmoment lazen).
    await expect(service.createBatch(peter.id, '2026-08', 'user-admin')).rejects.toMatchObject({ code: 'PAYROLL_BATCH_NO_TIME_ENTRIES' });
  });

  it('weigert createBatch() zonder ingesteld uurtarief', async () => {
    const zonderTarief: FakeEmployee = { ...peter, id: 'emp-zonder', displayName: 'Steven Zonder Tarief', defaultHourlyRateCents: null };
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: zonderTarief.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, signed: true },
    ];
    const { prisma } = createFakePrisma({ employees: [zonderTarief], projects: [projectNormal], assignments: [], entries });
    const service = new PayrollService(prisma);

    await expect(service.createBatch(zonderTarief.id, '2026-08', 'user-admin')).rejects.toMatchObject({ code: 'PAYROLL_BATCH_EMPLOYEE_HOURLY_RATE_NOT_SET' });
  });

  it('weigert createBatch() zonder betaalbare uren in de gekozen periode', async () => {
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments: [], entries: [] });
    const service = new PayrollService(prisma);

    await expect(service.createBatch(peter.id, '2026-08', 'user-admin')).rejects.toMatchObject({ code: 'PAYROLL_BATCH_NO_TIME_ENTRIES' });
  });

  it('remove() verwijdert een DRAFT-batch en geeft de tijdregistratie weer vrij', async () => {
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, signed: true },
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments: [], entries });
    const service = new PayrollService(prisma);

    const batch = await service.createBatch(peter.id, '2026-08', 'user-admin');
    expect(await service.listPayableSummary('2026-08')).toHaveLength(0);

    await service.remove(batch.id);
    expect(await service.listPayableSummary('2026-08')).toHaveLength(1);
  });

  it('niet-ondertekende tijdregistraties tellen niet mee (business rule 3)', async () => {
    const entries: FakeTimeEntry[] = [
      { id: 'te-1', employeeId: peter.id, projectId: projectNormal.id, startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, signed: false },
    ];
    const { prisma } = createFakePrisma({ employees: [peter], projects: [projectNormal], assignments: [], entries });
    const service = new PayrollService(prisma);

    expect(await service.listPayableSummary('2026-08')).toHaveLength(0);
  });
});
