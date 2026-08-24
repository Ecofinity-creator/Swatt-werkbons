import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { MilestoneSyncService } from '../src/modules/teamleader/milestone-sync.service';
import type { TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from '../src/modules/teamleader/teamleader-auth.service';

/**
 * Unit-tests met een minimale fake-Prisma (enkel de modellen/velden die
 * MilestoneSyncService effectief gebruikt) en een fake TeamleaderClient —
 * zelfde patroon als teamleader-user.service.test.ts en
 * teamleader-auth.service.test.ts.
 */

interface FakeProject {
  id: string;
  teamleaderId: string;
  isArchivedInTl: boolean;
  timeTrackingMilestoneId: string | null;
}

interface FakeMilestone {
  id: string;
  teamleaderId: string;
  projectId: string;
  name: string;
  status: string;
  dueOn: Date | null;
  isArchivedInTl: boolean;
}

function createFakePrisma(opts: {
  project: FakeProject;
  milestones?: FakeMilestone[];
  defaultMilestoneResponsibleTeamleaderUserId?: string | null;
}) {
  const project = { ...opts.project };
  let milestones = opts.milestones ? [...opts.milestones] : [];
  let nextMilestoneId = 100;

  const prisma = {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === project.id ? { ...project } : null)),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== project.id) throw new Error('project niet gevonden');
        const timeTrackingMilestone = project.timeTrackingMilestoneId
          ? (milestones.find((m) => m.id === project.timeTrackingMilestoneId) ?? null)
          : null;
        return { ...project, timeTrackingMilestone };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeProject> }) => {
        if (where.id !== project.id) throw new Error('project niet gevonden');
        Object.assign(project, data);
        return { ...project };
      }),
    },
    milestone: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { teamleaderId: string };
          create: Omit<FakeMilestone, 'id'>;
          update: Partial<FakeMilestone>;
        }) => {
          const existing = milestones.find((m) => m.teamleaderId === where.teamleaderId);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const created = { id: `local-${nextMilestoneId++}`, ...create };
          milestones.push(created);
          return { ...created };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { projectId: string; isArchivedInTl: boolean; teamleaderId: { notIn: string[] } };
          data: Partial<FakeMilestone>;
        }) => {
          let count = 0;
          milestones = milestones.map((m) => {
            if (m.projectId === where.projectId && m.isArchivedInTl === where.isArchivedInTl && !where.teamleaderId.notIn.includes(m.teamleaderId)) {
              count += 1;
              return { ...m, ...data };
            }
            return m;
          });
          return { count };
        },
      ),
      findMany: vi.fn(async ({ where }: { where: { projectId: string; isArchivedInTl: boolean } }) =>
        milestones
          .filter((m) => m.projectId === where.projectId && m.isArchivedInTl === where.isArchivedInTl)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => milestones.find((m) => m.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Omit<FakeMilestone, 'id'> }) => {
        const created = { id: `local-${nextMilestoneId++}`, ...data };
        milestones.push(created);
        return { ...created };
      }),
    },
    teamleaderConnection: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === TEAMLEADER_CONNECTION_SINGLETON_ID
          ? { defaultMilestoneResponsibleTeamleaderUserId: opts.defaultMilestoneResponsibleTeamleaderUserId ?? null }
          : null,
      ),
    },
  };

  return { prisma: prisma as unknown as PrismaClient, getMilestones: () => milestones, getProject: () => project };
}

function fakeClient(overrides: Partial<{ listAll: (...a: unknown[]) => Promise<unknown>; post: (...a: unknown[]) => Promise<unknown> }>): TeamleaderClient {
  return {
    post: vi.fn(overrides.post ?? (async () => ({ data: { id: 'tl-new' } }))),
    listAll: vi.fn(overrides.listAll ?? (async () => [])),
  } as unknown as TeamleaderClient;
}

describe('MilestoneSyncService', () => {
  it('syncForProject: cachet Teamleader-milestones lokaal en archiveert verdwenen milestones', async () => {
    const { prisma, getMilestones } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: null },
      milestones: [
        { id: 'm-oud', teamleaderId: 'tl-m-verdwenen', projectId: 'p1', name: 'Oude milestone', status: 'open', dueOn: null, isArchivedInTl: false },
      ],
    });
    const client = fakeClient({
      listAll: async () => [
        { id: 'tl-m1', project: { type: 'project', id: 'tl-p1' }, name: 'Fase 1', status: 'open', due_on: '2026-12-31' },
      ],
    });
    const service = new MilestoneSyncService(prisma, client);

    const result = await service.syncForProject('p1');

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Fase 1');
    const oud = getMilestones().find((m) => m.id === 'm-oud');
    expect(oud?.isArchivedInTl).toBe(true); // niet meer teruggekomen in de lijst → gearchiveerd, niet hard verwijderd
  });

  it('syncForProject: gooit ProjectErrors.notFound bij een onbekend of gearchiveerd project', async () => {
    const { prisma } = createFakePrisma({ project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: true, timeTrackingMilestoneId: null } });
    const client = fakeClient({});
    const service = new MilestoneSyncService(prisma, client);

    await expect(service.syncForProject('p1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolveOrCreateTeamleaderMilestoneId: hergebruikt de reeds gekozen milestone zonder Teamleader aan te roepen', async () => {
    const { prisma } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: 'm1' },
      milestones: [{ id: 'm1', teamleaderId: 'tl-m1', projectId: 'p1', name: 'Fase 1', status: 'open', dueOn: null, isArchivedInTl: false }],
    });
    const client = fakeClient({});
    const service = new MilestoneSyncService(prisma, client);

    const teamleaderId = await service.resolveOrCreateTeamleaderMilestoneId('p1');

    expect(teamleaderId).toBe('tl-m1');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('resolveOrCreateTeamleaderMilestoneId: gooit milestoneNotConfigured wanneer er geen keuze is EN geen default-verantwoordelijke ingesteld is', async () => {
    const { prisma } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: null },
      defaultMilestoneResponsibleTeamleaderUserId: null,
    });
    const client = fakeClient({});
    const service = new MilestoneSyncService(prisma, client);

    await expect(service.resolveOrCreateTeamleaderMilestoneId('p1')).rejects.toMatchObject({ code: 'TEAMLEADER_MILESTONE_NOT_CONFIGURED' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('resolveOrCreateTeamleaderMilestoneId: maakt automatisch een milestone aan via milestones.create wanneer een default-verantwoordelijke ingesteld is (de "flexibele" strategie)', async () => {
    const { prisma, getProject } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: null },
      defaultMilestoneResponsibleTeamleaderUserId: 'tl-user-1',
    });
    const client = fakeClient({ post: async (..._args) => ({ data: { id: 'tl-m-nieuw' } }) });
    const service = new MilestoneSyncService(prisma, client);

    const teamleaderId = await service.resolveOrCreateTeamleaderMilestoneId('p1');

    expect(teamleaderId).toBe('tl-m-nieuw');
    expect(client.post).toHaveBeenCalledWith(
      'milestones.create',
      expect.objectContaining({ project_id: 'tl-p1', responsible_user_id: 'tl-user-1', billing_method: 'time_and_materials' }),
    );
    expect(getProject().timeTrackingMilestoneId).toBeTruthy(); // volgende keer wordt deze nu hergebruikt i.p.v. opnieuw aangemaakt
  });

  it('setProjectMilestone: weigert een milestone die niet bij dit project hoort', async () => {
    const { prisma } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: null },
      milestones: [{ id: 'm-ander-project', teamleaderId: 'tl-m-x', projectId: 'p2', name: 'Andere werf', status: 'open', dueOn: null, isArchivedInTl: false }],
    });
    const client = fakeClient({});
    const service = new MilestoneSyncService(prisma, client);

    await expect(service.setProjectMilestone('p1', 'm-ander-project')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('setProjectMilestone: null heft de koppeling terug op', async () => {
    const { prisma, getProject } = createFakePrisma({
      project: { id: 'p1', teamleaderId: 'tl-p1', isArchivedInTl: false, timeTrackingMilestoneId: 'm1' },
      milestones: [{ id: 'm1', teamleaderId: 'tl-m1', projectId: 'p1', name: 'Fase 1', status: 'open', dueOn: null, isArchivedInTl: false }],
    });
    const client = fakeClient({});
    const service = new MilestoneSyncService(prisma, client);

    await service.setProjectMilestone('p1', null);

    expect(getProject().timeTrackingMilestoneId).toBeNull();
  });
});
