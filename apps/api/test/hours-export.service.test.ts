import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { HoursExportService } from '../src/modules/hours-export/hours-export.service';

/**
 * Werknemer vs. Onderaannemer — uren-export (backlog-item 30/8). Fake-Prisma
 * die enkel `employee.findMany` nabootst (de enige query die
 * HoursExportService gebruikt), zelfde patroon als invoice-batch.service.test.ts.
 */
interface FakeTimeEntry {
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  isManual: boolean;
  description: string | null;
  workOrderLink: {
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
  } | null;
}

interface FakeEmployee {
  id: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  timeEntries: FakeTimeEntry[];
}

function createFakePrisma(employees: FakeEmployee[]) {
  return {
    employee: {
      findMany: async ({ where }: { where: { id?: string } }) => {
        return employees
          .filter((employee) => (where.id ? employee.id === where.id : true))
          // Bootst de `where: { endedAt: { not: null } }` uit HoursExportService.loadEmployeesWithSignedEntries()
          // na — in de echte query gebeurt dit filter al op databankniveau, niet in-memory.
          .map((employee) => ({ ...employee, timeEntries: employee.timeEntries.filter((entry) => entry.endedAt !== null) }));
      },
    },
  } as unknown as PrismaClient;
}

function signedTimeEntry(
  overrides: Partial<FakeTimeEntry> & {
    workOrderId?: string;
    signedAt?: Date | null;
    projectId?: string;
    overtimeApplies?: boolean;
    overtimeThresholdType?: 'DAILY' | 'WEEKLY';
    overtimeWeeklyThresholdHours?: number | null;
  },
): FakeTimeEntry {
  const workOrderId = overrides.workOrderId ?? 'wo-1';
  const signedAt = overrides.signedAt === undefined ? new Date('2026-08-15T12:00:00Z') : overrides.signedAt;
  return {
    startedAt: new Date('2026-08-15T08:00:00Z'),
    endedAt: new Date('2026-08-15T16:00:00Z'),
    pausedSeconds: 1800,
    isManual: false,
    description: null,
    ...overrides,
    workOrderLink: signedAt
      ? {
          workOrder: {
            id: workOrderId,
            workOrderNumber: `WB-${workOrderId}`,
            project: {
              id: overrides.projectId ?? 'proj-1',
              name: 'Onderhoud warmtepomp',
              projectNumber: 'P-1',
              customer: { name: 'Janssens BV' },
              overtimeApplies: overrides.overtimeApplies ?? false,
              overtimeThresholdType: overrides.overtimeThresholdType ?? 'DAILY',
              overtimeWeeklyThresholdHours: overrides.overtimeWeeklyThresholdHours ?? null,
            },
            signature: { signedAt },
          },
        }
      : null,
  };
}

describe('HoursExportService', () => {
  it('listOverview() telt enkel gestopte tijdregistraties op een ondertekende werkbon binnen de opgevraagde periode', async () => {
    const employee: FakeEmployee = {
      id: 'emp-1',
      displayName: 'Peter',
      employmentType: 'EMPLOYEE',
      timeEntries: [
        signedTimeEntry({ workOrderId: 'wo-1' }), // 08:00-16:00 - 30min pauze = 7,5u, augustus
        signedTimeEntry({ workOrderId: 'wo-2', startedAt: new Date('2026-08-16T08:00:00Z'), endedAt: new Date('2026-08-16T10:00:00Z'), pausedSeconds: 0 }), // 2u, augustus
        signedTimeEntry({ workOrderId: 'wo-3', signedAt: new Date('2026-07-31T10:00:00Z') }), // andere periode
        signedTimeEntry({ workOrderId: 'wo-4', signedAt: null }), // niet ondertekend
        { ...signedTimeEntry({ workOrderId: 'wo-5' }), endedAt: null }, // nog lopende timer — moet uitgesloten worden
      ],
    };
    const service = new HoursExportService(createFakePrisma([employee]));

    const overview = await service.listOverview('2026-08');

    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({ employeeId: 'emp-1', displayName: 'Peter', workOrderCount: 2 });
    expect(overview[0]!.totalSeconds).toBe(7.5 * 3600 + 2 * 3600);
  });

  it('listEntriesForEmployees() geeft enkel EMPLOYEE-type medewerkers terug, gesorteerd op naam', async () => {
    const employees: FakeEmployee[] = [
      { id: 'emp-2', displayName: 'Wannes', employmentType: 'EMPLOYEE', timeEntries: [signedTimeEntry({ workOrderId: 'wo-1' })] },
      { id: 'sub-1', displayName: 'Aannemer BV', employmentType: 'SUBCONTRACTOR', timeEntries: [signedTimeEntry({ workOrderId: 'wo-2' })] },
      { id: 'emp-1', displayName: 'Peter', employmentType: 'EMPLOYEE', timeEntries: [signedTimeEntry({ workOrderId: 'wo-3' })] },
    ];
    const service = new HoursExportService(createFakePrisma(employees));

    const result = await service.listEntriesForEmployees('2026-08');

    expect(result.map((r) => r.displayName)).toEqual(['Peter', 'Wannes']);
    expect(result[0]!.entries).toHaveLength(1);
  });

  it('getSubcontractorDetail() groepeert per project en weigert een EMPLOYEE-type medewerker', async () => {
    const subcontractor: FakeEmployee = {
      id: 'sub-1',
      displayName: 'Aannemer BV',
      employmentType: 'SUBCONTRACTOR',
      timeEntries: [
        signedTimeEntry({ workOrderId: 'wo-1' }),
        signedTimeEntry({
          workOrderId: 'wo-2',
          startedAt: new Date('2026-08-20T08:00:00Z'),
          endedAt: new Date('2026-08-20T12:00:00Z'),
          pausedSeconds: 0,
        }),
      ],
    };
    const employee: FakeEmployee = { id: 'emp-1', displayName: 'Peter', employmentType: 'EMPLOYEE', timeEntries: [] };
    const service = new HoursExportService(createFakePrisma([subcontractor, employee]));

    const detail = await service.getSubcontractorDetail('sub-1', '2026-08');
    expect(detail.projects).toHaveLength(1);
    expect(detail.projects[0]!.entries).toHaveLength(2);
    // wo-1: 08:00-16:00 - 30min pauze = 7,5u; wo-2: 08:00-12:00 - geen pauze = 4u.
    expect(detail.totalSeconds).toBe(7.5 * 3600 + 4 * 3600);

    await expect(service.getSubcontractorDetail('emp-1', '2026-08')).rejects.toMatchObject({
      code: 'HOURS_EXPORT_WRONG_EMPLOYMENT_TYPE',
    });
  });

  it('getSubcontractorDetail() splitst normale uren/overuren per project (DAILY-drempel, 9u30 → 8u normaal + 1u30 overuren)', async () => {
    const subcontractor: FakeEmployee = {
      id: 'sub-1',
      displayName: 'Aannemer BV',
      employmentType: 'SUBCONTRACTOR',
      timeEntries: [
        signedTimeEntry({
          workOrderId: 'wo-1',
          startedAt: new Date('2026-08-20T07:00:00Z'),
          endedAt: new Date('2026-08-20T16:30:00Z'), // 9u30
          pausedSeconds: 0,
          overtimeApplies: true,
          overtimeThresholdType: 'DAILY',
        }),
      ],
    };
    const service = new HoursExportService(createFakePrisma([subcontractor]));

    const detail = await service.getSubcontractorDetail('sub-1', '2026-08');

    expect(detail.projects[0]!.entries[0]).toMatchObject({ normalHours: 8, overtimeHours: 1.5 });
    expect(detail.totalNormalHours).toBe(8);
    expect(detail.totalOvertimeHours).toBe(1.5);
  });

  it('getSubcontractorDetail() bucket overuren over meerdere werkbonnen heen bij een WEEKLY-drempel', async () => {
    const dayEntry = (day: string, workOrderId: string) =>
      signedTimeEntry({
        workOrderId,
        startedAt: new Date(`2026-08-${day}T06:00:00Z`),
        endedAt: new Date(`2026-08-${day}T20:00:00Z`), // 14u
        pausedSeconds: 0,
        overtimeApplies: true,
        overtimeThresholdType: 'WEEKLY',
        overtimeWeeklyThresholdHours: 39,
      });
    const subcontractor: FakeEmployee = {
      id: 'sub-1',
      displayName: 'Aannemer BV',
      employmentType: 'SUBCONTRACTOR',
      timeEntries: [dayEntry('17', 'wo-1'), dayEntry('18', 'wo-2'), dayEntry('19', 'wo-3')], // 3×14u = 42u
    };
    const service = new HoursExportService(createFakePrisma([subcontractor]));

    const detail = await service.getSubcontractorDetail('sub-1', '2026-08');

    // Exact hetzelfde acceptatiecriterium als bij de klantfactuur/personeelsuitbetaling: 39u normaal + 3u overuren.
    expect(detail.totalNormalHours).toBe(39);
    expect(detail.totalOvertimeHours).toBe(3);
  });

  it('weigert een ongeldig periode-formaat', async () => {
    const service = new HoursExportService(createFakePrisma([]));
    await expect(service.listOverview('augustus-2026')).rejects.toMatchObject({ code: 'HOURS_EXPORT_INVALID_PERIOD' });
  });

  it('getSubcontractorDetail() gooit HOURS_EXPORT_EMPLOYEE_NOT_FOUND voor een onbestaande medewerker', async () => {
    const service = new HoursExportService(createFakePrisma([]));
    await expect(service.getSubcontractorDetail('does-not-exist', '2026-08')).rejects.toMatchObject({
      code: 'HOURS_EXPORT_EMPLOYEE_NOT_FOUND',
    });
  });
});
