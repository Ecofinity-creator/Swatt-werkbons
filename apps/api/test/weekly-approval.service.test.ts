import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanySettingsService } from '../src/modules/company-settings/company-settings.service';
import { WeeklyApprovalService } from '../src/modules/work-orders/weekly-approval.service';
import type { StorageService } from '../src/modules/storage/storage.service';

/**
 * Unit-tests voor de weekondertekening (Phase 12, deel B) — fake-Prisma naar
 * hetzelfde patroon als invoice-batch.service.test.ts/payroll.service.test.ts.
 */

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  projectId: string;
  status: string;
  createdByEmployeeId: string;
  description: string | null;
  createdAt: Date;
  weeklyApprovalId: string | null;
  pdfStatus: string;
  teamleaderUploadStatus: string;
}

/** Phase 12, deel D — default: km-vergoeding niet actief (geen tarief ingesteld). */
function createFakeCompanySettingsService(kmRateCents: number | null = null): CompanySettingsService {
  return { get: async () => ({ kmRateCents }) } as unknown as CompanySettingsService;
}

function createFakeStorage(): StorageService {
  let counter = 0;
  return {
    save: async () => `fake-signature-key-${counter++}`,
    read: async () => {
      throw new Error('niet gebruikt in deze tests');
    },
  } as unknown as StorageService;
}

function createFakePrisma(initialWorkOrders: FakeWorkOrder[], projectKmDistanceOneWayMeters: number | null = null) {
  const workOrders = new Map(initialWorkOrders.map((wo) => [wo.id, { ...wo }]));
  const weeklyApprovals = new Map<string, { id: string; projectId: string; weekStartDate: Date; weekEndDate: Date; status: string; signerName: string | null; signerFunction: string | null; confirmedAt: Date | null; ipAddress: string | null; requestedByUserId: string | null }>();
  const signatures = new Map<string, { id: string; workOrderId: string }>();
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  const prisma = {
    project: {
      findUnique: async () => ({ kmDistanceOneWayMeters: projectKmDistanceOneWayMeters }),
    },
    workOrder: {
      findMany: async ({ where }: { where: { projectId: string; status: string; createdAt: { gte: Date; lte: Date } } }) =>
        Array.from(workOrders.values())
          .filter(
            (wo) =>
              wo.projectId === where.projectId &&
              wo.status === where.status &&
              wo.createdAt.getTime() >= where.createdAt.gte.getTime() &&
              wo.createdAt.getTime() <= where.createdAt.lte.getTime(),
          )
          .map((wo) => ({
            ...wo,
            timeEntries: [
              {
                timeEntryId: `te-${wo.id}`,
                timeEntry: {
                  employeeId: wo.createdByEmployeeId,
                  startedAt: wo.createdAt,
                  endedAt: new Date(wo.createdAt.getTime() + 4 * 60 * 60 * 1000), // 4u na start, willekeurig maar consistent
                  pausedSeconds: 0,
                  employee: { displayName: wo.createdByEmployeeId === PETER ? 'Peter Janssens' : 'Wannes Peeters' },
                },
              },
            ],
            photos: [],
          })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const id of where.id.in) {
          const wo = workOrders.get(id);
          if (wo) Object.assign(wo, data);
        }
        return { count: where.id.in.length };
      },
    },
    weeklyApproval: {
      upsert: async ({ where, create, update }: { where: { projectId_weekStartDate: { projectId: string; weekStartDate: Date } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const key = `${where.projectId_weekStartDate.projectId}|${where.projectId_weekStartDate.weekStartDate.toISOString()}`;
        const existing = Array.from(weeklyApprovals.values()).find(
          (wa) => wa.projectId === where.projectId_weekStartDate.projectId && wa.weekStartDate.getTime() === where.projectId_weekStartDate.weekStartDate.getTime(),
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const id = genId('weekly-approval');
        const record = { id, ...create } as (typeof weeklyApprovals extends Map<string, infer V> ? V : never);
        weeklyApprovals.set(key, record);
        return { ...record };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const wa = Array.from(weeklyApprovals.values()).find((row) => row.id === where.id);
        if (!wa) return null;
        return { ...wa, workOrders: Array.from(workOrders.values()).filter((wo) => wo.weeklyApprovalId === wa.id).map((wo) => ({ id: wo.id })) };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const wa = Array.from(weeklyApprovals.values()).find((row) => row.id === where.id);
        if (wa) Object.assign(wa, data);
        return wa;
      },
    },
    workOrderSignature: {
      create: async ({ data }: { data: { workOrderId: string } }) => {
        const id = genId('signature');
        signatures.set(id, { id, workOrderId: data.workOrderId });
        return { id, ...data };
      },
      deleteMany: async ({ where }: { where: { workOrderId: { in: string[] } } }) => {
        let count = 0;
        for (const [id, sig] of signatures) {
          if (where.workOrderId.in.includes(sig.workOrderId)) {
            signatures.delete(id);
            count++;
          }
        }
        return { count };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  return { prisma: prisma as unknown as PrismaClient, workOrders, weeklyApprovals, signatures };
}

const PROJECT_ID = 'proj-1';
const PETER = 'emp-peter';
const WANNES = 'emp-wannes';

// Maandag 17 augustus 2026 — willekeurige referentieweek.
const MONDAY = new Date('2026-08-17T10:00:00.000Z');
const WEDNESDAY = new Date('2026-08-19T14:00:00.000Z');
const SUNDAY = new Date('2026-08-23T09:00:00.000Z');
const NEXT_MONDAY = new Date('2026-08-24T08:00:00.000Z'); // volgende week — mag niet meetellen

function workOrder(overrides: Partial<FakeWorkOrder> & { id: string }): FakeWorkOrder {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    projectId: PROJECT_ID,
    status: 'DRAFT',
    createdByEmployeeId: PETER,
    description: 'Onderhoud uitgevoerd.',
    createdAt: MONDAY,
    weeklyApprovalId: null,
    pdfStatus: 'PDF_PENDING',
    teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_PENDING',
    ...overrides,
  };
}

const SIGN_INPUT = {
  signerName: 'Jan Janssens',
  signerFunction: 'Zaakvoerder',
  requestedByUserId: 'user-peter',
  ipAddress: '127.0.0.1',
  image: { data: Buffer.from('fake-png-bytes'), mimeType: 'image/png' },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('WeeklyApprovalService.weekBoundsOf()', () => {
  it('een maandag levert zichzelf als weekStartDate op', () => {
    const { weekStartDate, weekEndDate } = WeeklyApprovalService.weekBoundsOf(MONDAY);
    expect(weekStartDate.toISOString().slice(0, 10)).toBe('2026-08-17');
    expect(weekEndDate.toISOString().slice(0, 10)).toBe('2026-08-23');
  });

  it('een zondag hoort nog bij de week die op de vorige maandag begon', () => {
    const { weekStartDate, weekEndDate } = WeeklyApprovalService.weekBoundsOf(SUNDAY);
    expect(weekStartDate.toISOString().slice(0, 10)).toBe('2026-08-17');
    expect(weekEndDate.toISOString().slice(0, 10)).toBe('2026-08-23');
  });

  it('de maandag erna valt buiten diezelfde week', () => {
    const { weekEndDate } = WeeklyApprovalService.weekBoundsOf(MONDAY);
    expect(NEXT_MONDAY.getTime()).toBeGreaterThan(weekEndDate.getTime());
  });
});

describe('WeeklyApprovalService.signCurrentWeek()', () => {
  it('ondertekent alle openstaande werkbonnen van de week in één keer, ook van collega\'s', async () => {
    const { prisma, workOrders } = createFakePrisma([
      workOrder({ id: 'wo-1', createdByEmployeeId: PETER, createdAt: MONDAY }),
      workOrder({ id: 'wo-2', createdByEmployeeId: WANNES, createdAt: WEDNESDAY }),
      workOrder({ id: 'wo-3', createdByEmployeeId: PETER, createdAt: NEXT_MONDAY }), // volgende week — mag niet meegenomen worden
      workOrder({ id: 'wo-4', createdByEmployeeId: PETER, createdAt: MONDAY, status: 'SIGNED' }), // al ondertekend — mag niet nogmaals
    ]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());

    // Fixeer "vandaag" op de referentieweek via een lichte monkeypatch: signCurrentWeek() gebruikt Date.now() intern via weekBoundsOf(new Date()).
    vi.setSystemTime(MONDAY);
    const result = await service.signCurrentWeek(PROJECT_ID, SIGN_INPUT);
    expect(result.workOrderIds.sort()).toEqual(['wo-1', 'wo-2']);
    expect(result.status).toBe('SIGNED');
    expect(workOrders.get('wo-1')?.status).toBe('SIGNED');
    expect(workOrders.get('wo-2')?.status).toBe('SIGNED');
    expect(workOrders.get('wo-1')?.weeklyApprovalId).toBe(result.id);
    expect(workOrders.get('wo-2')?.weeklyApprovalId).toBe(result.id);
    // Niet aangeraakt:
    expect(workOrders.get('wo-3')?.status).toBe('DRAFT');
    expect(workOrders.get('wo-3')?.weeklyApprovalId).toBeNull();
  });

  it('weigert wanneer er geen enkele openstaande werkbon is die week', async () => {
    const { prisma } = createFakePrisma([workOrder({ id: 'wo-1', status: 'SIGNED' })]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());

    vi.setSystemTime(MONDAY);
    await expect(service.signCurrentWeek(PROJECT_ID, SIGN_INPUT)).rejects.toMatchObject({ code: 'WEEKLY_APPROVAL_NO_PENDING_WORK_ORDERS' });
  });
});

describe('WeeklyApprovalService.listPendingForEmployee()', () => {
  it('toont enkel de werkbonnen waar deze medewerker zelf bij betrokken is', async () => {
    const { prisma } = createFakePrisma([
      workOrder({ id: 'wo-1', createdByEmployeeId: PETER, createdAt: MONDAY }),
      workOrder({ id: 'wo-2', createdByEmployeeId: WANNES, createdAt: WEDNESDAY }),
    ]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());

    vi.setSystemTime(MONDAY);
    const result = await service.listPendingForEmployee(PETER, PROJECT_ID);
    expect(result.workOrderIds).toEqual(['wo-1']);
  });

  it('geeft "entries" terug over ALLE openstaande werkbonnen van de week heen (niet enkel die van de aanroepende medewerker) — op vraag: "alle tijden tonen zodat de ondertekenaar ziet wat hij goedkeurt"', async () => {
    const { prisma } = createFakePrisma([
      workOrder({ id: 'wo-1', createdByEmployeeId: PETER, createdAt: MONDAY }),
      workOrder({ id: 'wo-2', createdByEmployeeId: WANNES, createdAt: WEDNESDAY }),
    ]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());

    vi.setSystemTime(MONDAY);
    const result = await service.listPendingForEmployee(PETER, PROJECT_ID);

    // workOrderIds blijft gefilterd op Peter, maar entries toont ook Wannes se werkbon.
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.employeeDisplayName).sort()).toEqual(['Peter Janssens', 'Wannes Peeters']);
    expect(result.entries[0]?.startedAt.getTime()).toBeLessThanOrEqual(result.entries[1]!.startedAt.getTime()); // chronologisch gesorteerd
    expect(result.entries.every((e) => e.endedAt > e.startedAt)).toBe(true);
    expect(result.entries.map((e) => e.workOrderNumber)).toEqual(expect.arrayContaining(['WB-wo-1', 'WB-wo-2']));
  });
});

describe('WeeklyApprovalService.reopen()', () => {
  it('zet ondertekende werkbonnen terug naar DRAFT en wist de handtekening + PDF/sync-status', async () => {
    const { prisma, workOrders } = createFakePrisma([workOrder({ id: 'wo-1', createdAt: MONDAY })]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());

    vi.setSystemTime(MONDAY);
    const result = await service.signCurrentWeek(PROJECT_ID, SIGN_INPUT);
    const weeklyApprovalId = result.id;
    workOrders.get('wo-1')!.pdfStatus = 'PDF_READY';
    workOrders.get('wo-1')!.teamleaderUploadStatus = 'TEAMLEADER_UPLOADED';

    await service.reopen(weeklyApprovalId);

    expect(workOrders.get('wo-1')?.status).toBe('DRAFT');
    expect(workOrders.get('wo-1')?.pdfStatus).toBe('PDF_PENDING');
    expect(workOrders.get('wo-1')?.teamleaderUploadStatus).toBe('TEAMLEADER_UPLOAD_PENDING');
  });

  it('weigert een week te heropenen die nog niet ondertekend is', async () => {
    const { prisma } = createFakePrisma([workOrder({ id: 'wo-1' })]);
    const service = new WeeklyApprovalService(prisma, createFakeStorage(), createFakeCompanySettingsService());
    await expect(service.reopen('onbestaand-id')).rejects.toMatchObject({ code: 'WEEKLY_APPROVAL_NOT_FOUND' });
  });
});
