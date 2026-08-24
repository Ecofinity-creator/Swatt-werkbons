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
});
