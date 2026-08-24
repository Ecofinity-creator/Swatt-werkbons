import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SyncJobService } from '../src/modules/sync/sync-job.service';
import type { TimeTrackingSyncService } from '../src/modules/teamleader/time-tracking-sync.service';
import type { FileSyncService } from '../src/modules/teamleader/file-sync.service';

/**
 * `getSyncQueue()` (queue/queue.ts) verbindt lazy met een echte Redis via
 * ioredis/BullMQ — niet beschikbaar/gewenst in een unit-test. We mocken de
 * hele module zodat `tryEnqueue()` een fake `.add()` aanroept i.p.v. een
 * echte Redis-verbinding op te zetten.
 */
const addMock = vi.fn(async () => undefined);
vi.mock('../src/queue/queue', () => ({
  getSyncQueue: () => ({ add: addMock }),
}));

interface FakeSyncJob {
  id: string;
  workOrderId: string;
  type: 'TIME_ENTRIES' | 'PDF_UPLOAD';
  status: string;
  attempts: number;
  lastAttemptedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

interface FakeWorkOrder {
  id: string;
  status: string;
  teamleaderUploadStatus: string;
  timeEntries: { timeEntry: { syncStatus: string } }[];
}

function createFakePrisma(workOrder: FakeWorkOrder) {
  const wo = { ...workOrder };
  const jobs: FakeSyncJob[] = [];
  const logs: { syncJobId: string; attempt: number; status: string; message: string }[] = [];
  let nextId = 1;

  const prisma = {
    workOrder: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== wo.id) throw new Error('werkbon niet gevonden');
        return { ...wo };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeWorkOrder> }) => {
        if (where.id !== wo.id) throw new Error('werkbon niet gevonden');
        Object.assign(wo, data);
        return { ...wo };
      }),
    },
    syncJob: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { workOrderId_type: { workOrderId: string; type: string } };
          create: Omit<FakeSyncJob, 'id' | 'attempts' | 'lastAttemptedAt' | 'completedAt'>;
          update: Partial<FakeSyncJob>;
        }) => {
          const existing = jobs.find(
            (j) => j.workOrderId === where.workOrderId_type.workOrderId && j.type === where.workOrderId_type.type,
          );
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const job: FakeSyncJob = {
            id: `job-${nextId++}`,
            attempts: 0,
            lastAttemptedAt: null,
            completedAt: null,
            ...create,
          };
          jobs.push(job);
          return { ...job };
        },
      ),
      findMany: vi.fn(async ({ where }: { where?: { workOrderId?: string; status?: { in: string[] } } } = {}) => {
        if (!where) return jobs.map((j) => ({ ...j }));
        return jobs
          .filter((j) => (where.workOrderId ? j.workOrderId === where.workOrderId : true))
          .filter((j) => (where.status ? where.status.in.includes(j.status) : true))
          .map((j) => ({ ...j }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { workOrderId_type: { workOrderId: string; type: string } } }) => {
        const job = jobs.find(
          (j) => j.workOrderId === where.workOrderId_type.workOrderId && j.type === where.workOrderId_type.type,
        );
        return job ? { ...job } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeSyncJob> }) => {
        const job = jobs.find((j) => j.id === where.id);
        if (!job) throw new Error('syncjob niet gevonden');
        Object.assign(job, data);
        return { ...job };
      }),
    },
    syncLog: {
      create: vi.fn(async ({ data }: { data: { syncJobId: string; attempt: number; status: string; message: string } }) => {
        logs.push(data);
        return { id: `log-${logs.length}`, ...data };
      }),
    },
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    getJobs: () => jobs,
    getWorkOrder: () => wo,
    getLogs: () => logs,
  };
}

function fakeTimeTrackingSync(result: { success: boolean; message: string | null }): TimeTrackingSyncService {
  return { syncWorkOrder: vi.fn(async () => result) } as unknown as TimeTrackingSyncService;
}

function fakeFileSync(result: { success: boolean; message: string | null }): FileSyncService {
  return { uploadPdf: vi.fn(async () => result) } as unknown as FileSyncService;
}

describe('SyncJobService', () => {
  beforeEach(() => {
    addMock.mockClear();
  });

  it('enqueueForWorkOrder: maakt beide SyncJob-rijen aan (TIME_ENTRIES + PDF_UPLOAD) en plaatst ze op de queue', async () => {
    const { prisma, getJobs, getWorkOrder } = createFakePrisma({
      id: 'wo1',
      status: 'SIGNED',
      teamleaderUploadStatus: 'PDF_PENDING',
      timeEntries: [{ timeEntry: { syncStatus: 'PENDING' } }],
    });
    const service = new SyncJobService(prisma, fakeTimeTrackingSync({ success: true, message: null }), fakeFileSync({ success: true, message: null }));

    await service.enqueueForWorkOrder('wo1');

    expect(getJobs()).toHaveLength(2);
    expect(getJobs().map((j) => j.type).sort()).toEqual(['PDF_UPLOAD', 'TIME_ENTRIES']);
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(getWorkOrder().status).toBe('SYNC_PENDING'); // sectie 34, stap 9 (tussenstadium — nog niet READY_FOR_INVOICING)
  });

  it('enqueueForWorkOrder: zet de werkbonstatus niet terug vanaf INVOICED (business rule 7)', async () => {
    const { prisma, getWorkOrder } = createFakePrisma({
      id: 'wo1',
      status: 'INVOICED',
      teamleaderUploadStatus: 'TEAMLEADER_UPLOADED',
      timeEntries: [{ timeEntry: { syncStatus: 'SYNCED' } }],
    });
    const service = new SyncJobService(prisma, fakeTimeTrackingSync({ success: true, message: null }), fakeFileSync({ success: true, message: null }));

    await service.enqueueForWorkOrder('wo1');

    expect(getWorkOrder().status).toBe('INVOICED');
  });

  it('retry: slaat reeds SUCCEEDED jobs over, herqueuet enkel de rest', async () => {
    const { prisma, getJobs } = createFakePrisma({
      id: 'wo1',
      status: 'SYNC_FAILED',
      teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_FAILED',
      timeEntries: [{ timeEntry: { syncStatus: 'SYNCED' } }],
    });
    // Zet de twee jobs vooraf op: TIME_ENTRIES geslaagd, PDF_UPLOAD mislukt.
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'TIME_ENTRIES' } },
      create: { workOrderId: 'wo1', type: 'TIME_ENTRIES', status: 'SUCCEEDED' },
      update: {},
    });
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'PDF_UPLOAD' } },
      create: { workOrderId: 'wo1', type: 'PDF_UPLOAD', status: 'FAILED' },
      update: {},
    });
    addMock.mockClear();

    const service = new SyncJobService(prisma, fakeTimeTrackingSync({ success: true, message: null }), fakeFileSync({ success: true, message: null }));
    await service.retry('wo1');

    expect(addMock).toHaveBeenCalledTimes(1); // enkel PDF_UPLOAD herqueued
    const succeededJob = getJobs().find((j) => j.type === 'TIME_ENTRIES')!;
    expect(succeededJob.status).toBe('SUCCEEDED'); // ongemoeid gelaten
    const failedJob = getJobs().find((j) => j.type === 'PDF_UPLOAD')!;
    expect(failedJob.status).toBe('PENDING'); // teruggezet vóór herqueuing
  });

  it('processJob: zet WorkOrder.status op READY_FOR_INVOICING zodra beide synctypes geslaagd zijn (sectie 34, stap 9)', async () => {
    const { prisma, getWorkOrder } = createFakePrisma({
      id: 'wo1',
      status: 'SYNC_PENDING',
      teamleaderUploadStatus: 'TEAMLEADER_UPLOADED', // PDF_UPLOAD al gelukt
      timeEntries: [{ timeEntry: { syncStatus: 'PENDING' } }],
    });
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'TIME_ENTRIES' } },
      create: { workOrderId: 'wo1', type: 'TIME_ENTRIES', status: 'PENDING' },
      update: {},
    });

    // De echte TimeTrackingSyncService zou hier ook de TimeEntry.syncStatus
    // bijwerken naar SYNCED — voor deze test simuleren we dat effect zelf,
    // want recomputeWorkOrderStatus leest de workOrder opnieuw op uit prisma.
    const timeTrackingSync = {
      syncWorkOrder: vi.fn(async () => {
        (prisma.workOrder.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          ...getWorkOrder(),
          timeEntries: [{ timeEntry: { syncStatus: 'SYNCED' } }],
        });
        return { success: true, message: null };
      }),
    } as unknown as TimeTrackingSyncService;

    const service = new SyncJobService(prisma, timeTrackingSync, fakeFileSync({ success: true, message: null }));
    await service.processJob('wo1', 'TIME_ENTRIES');

    expect(getWorkOrder().status).toBe('READY_FOR_INVOICING');
  });

  it('processJob: zet WorkOrder.status op SYNC_FAILED en gooit verder (voor BullMQ-retries) bij een mislukking', async () => {
    const { prisma, getJobs, getWorkOrder, getLogs } = createFakePrisma({
      id: 'wo1',
      status: 'SYNC_PENDING',
      teamleaderUploadStatus: 'PDF_PENDING',
      timeEntries: [{ timeEntry: { syncStatus: 'PENDING' } }],
    });
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'PDF_UPLOAD' } },
      create: { workOrderId: 'wo1', type: 'PDF_UPLOAD', status: 'PENDING' },
      update: {},
    });

    const message = 'De PDF kon niet naar Teamleader geüpload worden.';
    // De échte FileSyncService zet bij een mislukking ook
    // WorkOrder.teamleaderUploadStatus op TEAMLEADER_UPLOAD_FAILED (zie
    // FileSyncService.markFailed) — dat effect simuleren we hier zelf, want
    // recomputeWorkOrderStatus() leest de werkbon opnieuw op uit prisma en
    // baseert zich op dat veld, niet op het SyncResult zelf.
    const fileSync = {
      uploadPdf: vi.fn(async () => {
        await prisma.workOrder.update({ where: { id: 'wo1' }, data: { teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_FAILED' } });
        return { success: false, message };
      }),
    } as unknown as FileSyncService;
    const service = new SyncJobService(prisma, fakeTimeTrackingSync({ success: true, message: null }), fileSync);

    await expect(service.processJob('wo1', 'PDF_UPLOAD')).rejects.toThrow(message);

    const job = getJobs().find((j) => j.type === 'PDF_UPLOAD')!;
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toBe(message);
    expect(getWorkOrder().status).toBe('SYNC_FAILED');
    expect(getLogs().some((l) => l.status === 'FAILED' && l.message === message)).toBe(true);
  });

  it('reconcilePendingJobs: herqueuet PENDING en (crash-)PROCESSING jobs, laat SUCCEEDED/FAILED met rust', async () => {
    const { prisma } = createFakePrisma({
      id: 'wo1',
      status: 'SYNC_PENDING',
      teamleaderUploadStatus: 'PDF_PENDING',
      timeEntries: [],
    });
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'TIME_ENTRIES' } },
      create: { workOrderId: 'wo1', type: 'TIME_ENTRIES', status: 'PENDING' },
      update: {},
    });
    await prisma.syncJob.upsert({
      where: { workOrderId_type: { workOrderId: 'wo1', type: 'PDF_UPLOAD' } },
      create: { workOrderId: 'wo1', type: 'PDF_UPLOAD', status: 'PROCESSING' }, // server crashte tijdens verwerking
      update: {},
    });
    addMock.mockClear();

    const service = new SyncJobService(prisma, fakeTimeTrackingSync({ success: true, message: null }), fakeFileSync({ success: true, message: null }));
    const count = await service.reconcilePendingJobs();

    expect(count).toBe(2);
    expect(addMock).toHaveBeenCalledTimes(2);
  });
});
