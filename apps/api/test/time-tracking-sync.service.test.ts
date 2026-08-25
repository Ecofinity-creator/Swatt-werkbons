import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TimeTrackingSyncService } from '../src/modules/teamleader/time-tracking-sync.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import type { MilestoneSyncService } from '../src/modules/teamleader/milestone-sync.service';

/**
 * Unit-tests voor de kern van business rule 5 (idempotentie) en de
 * pauzetijd-aftrek uit sectie 14 — met een fake-Prisma (enkel timeEntry.update/
 * updateMany en workOrder.findUniqueOrThrow, precies wat deze service
 * gebruikt) en een fake TeamleaderClient/MilestoneSyncService.
 */

interface FakeTimeEntry {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  description: string | null;
  syncStatus: string;
  teamleaderTimeTrackingId?: string | null;
  syncError?: string | null;
  employee: { displayName: string; user: { teamleaderUserId: string | null } };
}

function createFakePrisma(workOrder: { id: string; projectId: string; description: string | null; timeEntries: FakeTimeEntry[] }) {
  const entries = new Map(workOrder.timeEntries.map((e) => [e.id, { ...e }]));

  const prisma = {
    workOrder: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== workOrder.id) throw new Error('werkbon niet gevonden');
        return {
          id: workOrder.id,
          projectId: workOrder.projectId,
          description: workOrder.description,
          project: { id: workOrder.projectId },
          timeEntries: Array.from(entries.values()).map((timeEntry) => ({ timeEntry })),
        };
      }),
    },
    timeEntry: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeTimeEntry> }) => {
        const existing = entries.get(where.id);
        if (!existing) throw new Error('tijdsregistratie niet gevonden');
        Object.assign(existing, data);
        return { ...existing };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<FakeTimeEntry> }) => {
        let count = 0;
        for (const id of where.id.in) {
          const existing = entries.get(id);
          if (existing) {
            Object.assign(existing, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };

  return { prisma: prisma as unknown as PrismaClient, getEntry: (id: string) => entries.get(id) };
}

function fakeClient(post: (...args: unknown[]) => Promise<unknown>): TeamleaderClient {
  return { post: vi.fn(post), listAll: vi.fn() } as unknown as TeamleaderClient;
}

function fakeMilestoneSync(teamleaderId: string | (() => Promise<string>)): MilestoneSyncService {
  return {
    resolveOrCreateTeamleaderMilestoneId: vi.fn(async () => (typeof teamleaderId === 'string' ? teamleaderId : teamleaderId())),
  } as unknown as MilestoneSyncService;
}

const employee = (teamleaderUserId: string | null = 'tl-user-peter') => ({
  displayName: 'Peter Janssens',
  user: { teamleaderUserId },
});

describe('TimeTrackingSyncService', () => {
  it('is idempotent (business rule 5): een reeds SYNCED registratie wordt nooit opnieuw gepost', async () => {
    const { prisma } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        {
          id: 'te1',
          startedAt: new Date('2026-08-24T08:00:00Z'),
          endedAt: new Date('2026-08-24T10:17:00Z'),
          pausedSeconds: 0,
          description: 'Onderhoud uitgevoerd.',
          syncStatus: 'SYNCED',
          employee: employee(),
        },
      ],
    });
    const client = fakeClient(async () => ({ data: { id: 'tl-time-1' } }));
    const service = new TimeTrackingSyncService(prisma, client, fakeMilestoneSync('tl-m1'));

    const result = await service.syncWorkOrder('wo1');

    expect(result).toEqual({ success: true, message: null });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('trekt de pauzetijd af van de wandklok-duur (started_at + duration, niet ended_at)', async () => {
    const { prisma } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        {
          id: 'te1',
          startedAt: new Date('2026-08-24T08:00:00Z'),
          endedAt: new Date('2026-08-24T10:17:00Z'), // 2u17
          pausedSeconds: 17 * 60, // 17 min pauze → netto 2u00
          description: 'Onderhoud uitgevoerd. Filters gereinigd.',
          syncStatus: 'PENDING',
          employee: employee(),
        },
      ],
    });
    const client = fakeClient(async () => ({ data: { id: 'tl-time-1' } }));
    const service = new TimeTrackingSyncService(prisma, client, fakeMilestoneSync('tl-m1'));

    const result = await service.syncWorkOrder('wo1');

    expect(result).toEqual({ success: true, message: null });
    expect(client.post).toHaveBeenCalledWith(
      'timeTracking.add',
      expect.objectContaining({
        started_at: '2026-08-24T08:00:00+00:00',
        duration: 2 * 60 * 60, // 2 uur netto, pauze reeds afgetrokken
        subject: { type: 'milestone', id: 'tl-m1' },
        user_id: 'tl-user-peter',
        invoiceable: true,
      }),
    );
  });

  it('markeert alle nog-niet-gesynchroniseerde registraties als FAILED wanneer de milestone niet bepaald kan worden', async () => {
    const { prisma, getEntry } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        {
          id: 'te1',
          startedAt: new Date(),
          endedAt: new Date(),
          pausedSeconds: 0,
          description: null,
          syncStatus: 'PENDING',
          employee: employee(),
        },
      ],
    });
    const client = fakeClient(async () => ({ data: { id: 'x' } }));
    const milestoneSync = {
      resolveOrCreateTeamleaderMilestoneId: vi.fn(async () => {
        throw new Error('Er is nog geen werkbon-uren-milestone geconfigureerd voor dit project.');
      }),
    } as unknown as MilestoneSyncService;
    const service = new TimeTrackingSyncService(prisma, client, milestoneSync);

    const result = await service.syncWorkOrder('wo1');

    expect(result.success).toBe(false);
    expect(getEntry('te1')?.syncStatus).toBe('FAILED');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('markeert een registratie als FAILED (met mensentaal-boodschap) wanneer de werknemer niet aan een Teamleader-gebruiker gekoppeld is, en gaat door met de andere registraties', async () => {
    const { prisma, getEntry } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        {
          id: 'te-niet-gekoppeld',
          startedAt: new Date('2026-08-24T08:00:00Z'),
          endedAt: new Date('2026-08-24T10:00:00Z'),
          pausedSeconds: 0,
          description: null,
          syncStatus: 'PENDING',
          employee: employee(null),
        },
        {
          id: 'te-wel-gekoppeld',
          startedAt: new Date('2026-08-24T08:00:00Z'),
          endedAt: new Date('2026-08-24T10:00:00Z'),
          pausedSeconds: 0,
          description: null,
          syncStatus: 'PENDING',
          employee: employee('tl-user-wannes'),
        },
      ],
    });
    const client = fakeClient(async () => ({ data: { id: 'tl-time-ok' } }));
    const service = new TimeTrackingSyncService(prisma, client, fakeMilestoneSync('tl-m1'));

    const result = await service.syncWorkOrder('wo1');

    expect(result.success).toBe(false);
    expect(getEntry('te-niet-gekoppeld')?.syncStatus).toBe('FAILED');
    expect(getEntry('te-niet-gekoppeld')?.syncError).toContain('Peter Janssens');
    expect(getEntry('te-wel-gekoppeld')?.syncStatus).toBe('SYNCED'); // niet geblokkeerd door de andere mislukking
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('markeert een registratie als FAILED bij een Teamleader-API-fout, zonder de andere registraties te blokkeren', async () => {
    const { prisma, getEntry } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        { id: 'te-faalt', startedAt: new Date('2026-08-24T08:00:00Z'), endedAt: new Date('2026-08-24T09:00:00Z'), pausedSeconds: 0, description: null, syncStatus: 'PENDING', employee: employee('tl-user-peter') },
        { id: 'te-lukt', startedAt: new Date('2026-08-24T08:00:00Z'), endedAt: new Date('2026-08-24T09:00:00Z'), pausedSeconds: 0, description: null, syncStatus: 'PENDING', employee: employee('tl-user-wannes') },
      ],
    });
    let call = 0;
    const client = fakeClient(async () => {
      call += 1;
      if (call === 1) throw new TeamleaderApiError(422, 'timeTracking.add', 'timeTracking.add gaf 422 terug');
      return { data: { id: 'tl-time-ok' } };
    });
    const service = new TimeTrackingSyncService(prisma, client, fakeMilestoneSync('tl-m1'));

    const result = await service.syncWorkOrder('wo1');

    expect(result.success).toBe(false);
    expect(getEntry('te-faalt')?.syncStatus).toBe('FAILED');
    expect(getEntry('te-lukt')?.syncStatus).toBe('SYNCED');
  });

  it('slaat het Teamleader time-tracking-ID en een payload-hash op bij een geslaagde sync', async () => {
    const { prisma, getEntry } = createFakePrisma({
      id: 'wo1',
      projectId: 'p1',
      description: null,
      timeEntries: [
        { id: 'te1', startedAt: new Date('2026-08-24T08:00:00Z'), endedAt: new Date('2026-08-24T09:00:00Z'), pausedSeconds: 0, description: null, syncStatus: 'PENDING', employee: employee() },
      ],
    });
    const client = fakeClient(async () => ({ data: { id: 'tl-time-42' } }));
    const service = new TimeTrackingSyncService(prisma, client, fakeMilestoneSync('tl-m1'));

    await service.syncWorkOrder('wo1');

    const entry = getEntry('te1');
    expect(entry?.syncStatus).toBe('SYNCED');
    expect(entry?.teamleaderTimeTrackingId).toBe('tl-time-42');
  });
});
