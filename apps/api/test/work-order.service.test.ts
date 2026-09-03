import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WorkOrderService } from '../src/modules/work-orders/work-order.service';

/**
 * Unit-tests met een minimale fake-Prisma — zelfde patroon als
 * time-entry.service.test.ts. Dekt de kern van Phase 5: een werkbon bundelt
 * enkel eigen, gestopte, nog niet-gekoppelde tijdsregistraties van hetzelfde
 * project, en het werkbonnummer wordt atomair en correct opeenvolgend
 * toegekend (WB-<jaar>-<6 cijfers>).
 */

interface FakeProject {
  id: string;
  isArchivedInTl: boolean;
  name: string;
  customerName: string;
}

interface FakeEmployee {
  id: string;
  displayName: string;
}

interface FakeTimeEntry {
  id: string;
  employeeId: string;
  projectId: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
}

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  projectId: string;
  status: 'DRAFT';
  description: string | null;
  createdByEmployeeId: string;
  createdAt: Date;
  updatedAt: Date;
  timeEntryIds: string[];
}

function createFakePrisma(options: {
  projects?: FakeProject[];
  employees?: FakeEmployee[];
  timeEntries?: FakeTimeEntry[];
} = {}) {
  const projects = new Map((options.projects ?? []).map((p) => [p.id, p]));
  const employees = new Map((options.employees ?? []).map((e) => [e.id, e]));
  const timeEntries = new Map((options.timeEntries ?? []).map((e) => [e.id, e]));
  const workOrders = new Map<string, FakeWorkOrder>();
  const linkedTimeEntryIds = new Set<string>();
  const counters = new Map<number, number>();
  let workOrderIdCounter = 0;

  function toRecord(workOrder: FakeWorkOrder) {
    const project = projects.get(workOrder.projectId);
    return {
      ...workOrder,
      project: { name: project?.name ?? 'Onbekend project', customer: { name: project?.customerName ?? 'Onbekende klant' } },
      createdByEmployee: { displayName: employees.get(workOrder.createdByEmployeeId)?.displayName ?? 'Onbekend' },
      timeEntries: workOrder.timeEntryIds.map((timeEntryId) => {
        const entry = timeEntries.get(timeEntryId)!;
        return {
          id: `wote-${timeEntryId}`,
          timeEntry: {
            ...entry,
            employee: { displayName: employees.get(entry.employeeId)?.displayName ?? 'Onbekend' },
          },
        };
      }),
    };
  }

  const workOrder = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = workOrders.get(where.id);
      return found ? toRecord(found) : null;
    }),
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { projectId: string; status: string; OR: Array<{ createdByEmployeeId?: string; timeEntries?: { some: { timeEntry: { employeeId: string } } } }> };
      }) => {
        const requestedEmployeeId =
          (where.OR.find((clause) => 'createdByEmployeeId' in clause)?.createdByEmployeeId as string | undefined) ??
          where.OR.find((clause) => 'timeEntries' in clause)?.timeEntries?.some.timeEntry.employeeId;
        return Array.from(workOrders.values())
          .filter((wo) => wo.projectId === where.projectId && wo.status === where.status)
          .filter(
            (wo) =>
              wo.createdByEmployeeId === requestedEmployeeId ||
              wo.timeEntryIds.some((tid) => timeEntries.get(tid)?.employeeId === requestedEmployeeId),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((wo) => ({
            id: wo.id,
            workOrderNumber: wo.workOrderNumber,
            description: wo.description,
            createdAt: wo.createdAt,
            timeEntries: wo.timeEntryIds.map((tid) => ({ timeEntry: timeEntries.get(tid)! })),
          }));
      },
    ),
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          workOrderNumber: string;
          projectId: string;
          description: string | null;
          createdByEmployeeId: string;
          timeEntries: { create: Array<{ timeEntryId: string }> };
        };
      }) => {
        const timeEntryIds = data.timeEntries.create.map((c) => c.timeEntryId);
        for (const id of timeEntryIds) {
          if (linkedTimeEntryIds.has(id)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: Prisma.prismaVersion.client,
            });
          }
        }
        const id = `wo-${++workOrderIdCounter}`;
        const now = new Date();
        const created: FakeWorkOrder = {
          id,
          workOrderNumber: data.workOrderNumber,
          projectId: data.projectId,
          status: 'DRAFT',
          description: data.description,
          createdByEmployeeId: data.createdByEmployeeId,
          createdAt: now,
          updatedAt: now,
          timeEntryIds,
        };
        workOrders.set(id, created);
        timeEntryIds.forEach((tid) => linkedTimeEntryIds.add(tid));
        return toRecord(created);
      },
    ),
  };

  const project = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null),
  };

  const timeEntry = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      return where.id.in
        .map((id) => timeEntries.get(id))
        .filter((e): e is FakeTimeEntry => e !== undefined)
        .map((e) => ({ ...e, workOrderLink: linkedTimeEntryIds.has(e.id) ? { id: `link-${e.id}` } : null }));
    }),
  };

  const workOrderCounter = {
    create: vi.fn(async ({ data }: { data: { year: number; lastNumber: number } }) => {
      if (counters.has(data.year)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
        });
      }
      counters.set(data.year, data.lastNumber);
      return { year: data.year, lastNumber: data.lastNumber };
    }),
    update: vi.fn(async ({ where }: { where: { year: number } }) => {
      const current = counters.get(where.year) ?? 0;
      const next = current + 1;
      counters.set(where.year, next);
      return { year: where.year, lastNumber: next };
    }),
  };

  return {
    prisma: { workOrder, project, timeEntry, workOrderCounter } as unknown as PrismaClient,
    workOrders,
  };
}

const PROJECT: FakeProject = { id: 'project-1', isArchivedInTl: false, name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' };
const EMPLOYEE: FakeEmployee = { id: 'employee-1', displayName: 'Peter' };

function stoppedEntry(overrides: Partial<FakeTimeEntry> = {}): FakeTimeEntry {
  return {
    id: 'entry-1',
    employeeId: EMPLOYEE.id,
    projectId: PROJECT.id,
    status: 'STOPPED',
    startedAt: new Date('2026-08-24T08:00:00Z'),
    endedAt: new Date('2026-08-24T10:17:00Z'),
    pausedSeconds: 0,
    ...overrides,
  };
}

describe('WorkOrderService', () => {
  it('create() maakt een DRAFT-werkbon aan met werkbonnummer WB-<jaar>-000001 bij de eerste werkbon', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry()],
    });
    const service = new WorkOrderService(prisma);

    const workOrder = await service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], 'Onderhoud uitgevoerd.');

    expect(workOrder.status).toBe('DRAFT');
    expect(workOrder.description).toBe('Onderhoud uitgevoerd.');
    expect(workOrder.project).toEqual({ name: 'Onderhoud warmtepomp', customer: { name: 'Janssens BV' } });
    expect(workOrder.createdByEmployee).toEqual({ displayName: 'Peter' });
    expect(workOrder.timeEntries).toHaveLength(1);
    expect(workOrder.timeEntries[0]!.timeEntry.employee).toEqual({ displayName: 'Peter' });
    expect(workOrder.workOrderNumber).toMatch(/^WB-\d{4}-000001$/);
  });

  it('create() kent opeenvolgende werkbonnummers toe binnen hetzelfde jaar', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry({ id: 'entry-1' }), stoppedEntry({ id: 'entry-2' })],
    });
    const service = new WorkOrderService(prisma);

    const first = await service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null);
    const second = await service.create(EMPLOYEE.id, PROJECT.id, ['entry-2'], null);

    const firstNumber = Number(first.workOrderNumber.split('-')[2]);
    const secondNumber = Number(second.workOrderNumber.split('-')[2]);
    expect(secondNumber).toBe(firstNumber + 1);
  });

  it('create() weigert zonder tijdsregistraties (WORK_ORDER_NO_TIME_ENTRIES)', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], employees: [EMPLOYEE] });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, [], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_NO_TIME_ENTRIES',
    });
  });

  it('create() weigert met PROJECT_NOT_FOUND voor een onbestaand of gearchiveerd project', async () => {
    const { prisma } = createFakePrisma({
      projects: [{ ...PROJECT, id: 'project-archived', isArchivedInTl: true }],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry({ projectId: 'project-archived' })],
    });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, 'project-onbestaand', ['entry-1'], null)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(service.create(EMPLOYEE.id, 'project-archived', ['entry-1'], null)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('create() weigert met WORK_ORDER_INVALID_TIME_ENTRY bij een onbestaande tijdsregistratie', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], employees: [EMPLOYEE] });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-onbestaand'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_INVALID_TIME_ENTRY',
    });
  });

  it('create() weigert met WORK_ORDER_INVALID_TIME_ENTRY voor de tijdsregistratie van een andere werknemer', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE, { id: 'employee-2', displayName: 'Wannes' }],
      timeEntries: [stoppedEntry({ employeeId: 'employee-2' })],
    });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_INVALID_TIME_ENTRY',
    });
  });

  it('create() weigert met WORK_ORDER_INVALID_TIME_ENTRY voor een nog lopende (niet-STOPPED) registratie', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry({ status: 'RUNNING', endedAt: null })],
    });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_INVALID_TIME_ENTRY',
    });
  });

  it('create() weigert met WORK_ORDER_TIME_ENTRY_PROJECT_MISMATCH wanneer de registratie bij een ander project hoort', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT, { ...PROJECT, id: 'project-2', name: 'Ander project' }],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry({ projectId: 'project-2' })],
    });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_TIME_ENTRY_PROJECT_MISMATCH',
    });
  });

  it('create() weigert met WORK_ORDER_TIME_ENTRY_ALREADY_LINKED wanneer de registratie al aan een werkbon hangt', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry()],
    });
    const service = new WorkOrderService(prisma);
    await service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_TIME_ENTRY_ALREADY_LINKED',
    });
  });

  it('create() vertaalt een unique-constraint-fout (P2002) van create() naar WORK_ORDER_TIME_ENTRY_ALREADY_LINKED', async () => {
    // Simuleert de race condition tussen twee gelijktijdige aanvragen die
    // dezelfde tijdsregistratie proberen te koppelen: de voorafgaande check
    // vond op dat moment nog geen koppeling, maar de create() zelf botst
    // alsnog op de unieke `time_entry_id`-index (rechtstreeks geverifieerd
    // tegen een echte Postgres bij het bouwen van deze migratie).
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry()],
    });
    const fakeTimeEntry = (prisma as unknown as { timeEntry: Record<string, unknown> }).timeEntry;
    fakeTimeEntry.findMany = vi.fn(async () => [{ ...stoppedEntry(), workOrderLink: null }]);
    const fakeWorkOrder = (prisma as unknown as { workOrder: Record<string, unknown> }).workOrder;
    fakeWorkOrder.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      });
    });
    const service = new WorkOrderService(prisma);

    await expect(service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], null)).rejects.toMatchObject({
      code: 'WORK_ORDER_TIME_ENTRY_ALREADY_LINKED',
    });
  });

  it('get() geeft WORK_ORDER_NOT_FOUND voor een onbestaande werkbon', async () => {
    const { prisma } = createFakePrisma();
    const service = new WorkOrderService(prisma);

    await expect(service.get('onbestaand')).rejects.toMatchObject({ code: 'WORK_ORDER_NOT_FOUND' });
  });

  it('get() geeft de aangemaakte werkbon terug met project-, klant- en medewerkersgegevens', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      employees: [EMPLOYEE],
      timeEntries: [stoppedEntry()],
    });
    const service = new WorkOrderService(prisma);
    const created = await service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], 'Test');

    const fetched = await service.get(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.workOrderNumber).toBe(created.workOrderNumber);
    expect(fetched.timeEntries).toHaveLength(1);
  });

  describe('listDraftsForEmployeeOnProject() — op vraag (3/9/2026): naar niet-getekende werkbonnen kunnen navigeren zonder een nieuwe aan te maken', () => {
    it('toont enkel DRAFT-werkbonnen van dit project waar de medewerker zelf bij betrokken is, meest recente eerst', async () => {
      const collega: FakeEmployee = { id: 'employee-2', displayName: 'Wannes' };
      const anderProject: FakeProject = { id: 'project-2', isArchivedInTl: false, name: 'Interventie', customerName: 'De Smet NV' };
      const { prisma, workOrders } = createFakePrisma({
        projects: [PROJECT, anderProject],
        employees: [EMPLOYEE, collega],
        timeEntries: [stoppedEntry({ id: 'entry-1' }), stoppedEntry({ id: 'entry-2', employeeId: collega.id })],
      });
      // Rechtstreeks in de fake data-laag ingevoegd (i.p.v. via service.create()
      // tweemaal aan te roepen) — dit test enkel listDraftsForEmployeeOnProject()
      // zelf, niet de werkbonnummer-allocatie (die heeft al eigen tests hierboven).
      workOrders.set('wo-eigen', {
        id: 'wo-eigen',
        workOrderNumber: 'WB-2026-000001',
        projectId: PROJECT.id,
        status: 'DRAFT',
        description: 'Eigen werkbon',
        createdByEmployeeId: EMPLOYEE.id,
        createdAt: new Date('2026-08-20T09:00:00Z'),
        updatedAt: new Date('2026-08-20T09:00:00Z'),
        timeEntryIds: ['entry-1'],
      });
      workOrders.set('wo-collega', {
        id: 'wo-collega',
        workOrderNumber: 'WB-2026-000002',
        projectId: PROJECT.id,
        status: 'DRAFT',
        description: 'Werkbon van collega',
        createdByEmployeeId: collega.id,
        createdAt: new Date('2026-08-21T09:00:00Z'), // later dan wo-eigen
        updatedAt: new Date('2026-08-21T09:00:00Z'),
        timeEntryIds: ['entry-2'],
      });
      const service = new WorkOrderService(prisma);

      const drafts = await service.listDraftsForEmployeeOnProject(EMPLOYEE.id, PROJECT.id);

      expect(drafts.map((d) => d.id)).toEqual(['wo-eigen']);
      expect(drafts[0]?.description).toBe('Eigen werkbon');
    });

    it('toont een werkbon ook wanneer de medewerker enkel via een eigen tijdregistratie betrokken is (niet de aanmaker) — bv. twee medewerkers samen op dezelfde werf (sectie 8)', async () => {
      const collega: FakeEmployee = { id: 'employee-2', displayName: 'Wannes' };
      const { prisma, workOrders } = createFakePrisma({
        projects: [PROJECT],
        employees: [EMPLOYEE, collega],
        timeEntries: [stoppedEntry({ id: 'entry-1', employeeId: EMPLOYEE.id })],
      });
      // Rechtstreeks in de fake data-laag ingevoegd i.p.v. via service.create()
      // (die terecht valideert dat elke meegegeven tijdregistratie van de
      // aanmakende medewerker zelf moet zijn) — dit test enkel de leeskant:
      // een werkbon aangemaakt door de collega, met Peters tijdregistratie
      // erin gekoppeld.
      workOrders.set('wo-samen', {
        id: 'wo-samen',
        workOrderNumber: 'WB-2026-000999',
        projectId: PROJECT.id,
        status: 'DRAFT',
        description: 'Samen uitgevoerd',
        createdByEmployeeId: collega.id,
        createdAt: new Date('2026-08-20T09:00:00Z'),
        updatedAt: new Date('2026-08-20T09:00:00Z'),
        timeEntryIds: ['entry-1'],
      });
      const service = new WorkOrderService(prisma);

      const drafts = await service.listDraftsForEmployeeOnProject(EMPLOYEE.id, PROJECT.id);

      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.id).toBe('wo-samen');
    });

    it('berekent totalSeconds correct op basis van de onderliggende tijdregistraties', async () => {
      const { prisma } = createFakePrisma({
        projects: [PROJECT],
        employees: [EMPLOYEE],
        timeEntries: [
          stoppedEntry({
            id: 'entry-1',
            startedAt: new Date('2026-08-20T08:00:00Z'),
            endedAt: new Date('2026-08-20T10:00:00Z'),
            pausedSeconds: 600,
          }),
        ],
      });
      const service = new WorkOrderService(prisma);
      await service.create(EMPLOYEE.id, PROJECT.id, ['entry-1'], 'Test');

      const drafts = await service.listDraftsForEmployeeOnProject(EMPLOYEE.id, PROJECT.id);

      expect(drafts[0]?.totalSeconds).toBe(2 * 3600 - 600); // 2u min 10min pauze
    });

    it('geeft een lege lijst terug zonder openstaande werkbonnen', async () => {
      const { prisma } = createFakePrisma({ projects: [PROJECT], employees: [EMPLOYEE] });
      const service = new WorkOrderService(prisma);

      const drafts = await service.listDraftsForEmployeeOnProject(EMPLOYEE.id, PROJECT.id);

      expect(drafts).toEqual([]);
    });
  });
});
