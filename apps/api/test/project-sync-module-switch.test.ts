import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { ProjectSyncService } from '../src/modules/teamleader/project-sync.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';

/**
 * Bugreport 7/10/2026 — na het overschakelen van het Ecofinity- (legacy) naar
 * het Swatt-Teamleader-account (projects-v2) gaf "Synchroniseer projecten":
 * "projects.list gaf 403 terug: You have no access to this module", omdat de
 * gecachte `projectsModule` nog bij het vorige account hoorde.
 */

function createFakePrisma(cachedModule: 'LEGACY' | 'PROJECTS_V2') {
  const connection = { id: 'singleton', projectsModule: cachedModule as 'LEGACY' | 'PROJECTS_V2' | null };
  const prisma = {
    teamleaderConnection: {
      findUnique: async () => connection,
      update: async ({ data }: { data: { projectsModule: 'LEGACY' | 'PROJECTS_V2' } }) => {
        connection.projectsModule = data.projectsModule;
        return connection;
      },
    },
    customer: { upsert: async () => ({ id: 'cust-1' }) },
    project: {
      findUnique: async () => null,
      findMany: async () => [],
      upsert: async () => ({ id: 'proj-1' }),
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, connection };
}

function fakeClient(accountModule: 'legacy' | 'projects-v2', calls: string[]): TeamleaderClient {
  const noAccess = (endpoint: string) =>
    new TeamleaderApiError(403, endpoint, `${endpoint} gaf 403 terug: You have no access to this module`);
  return {
    post: async (endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === 'accounts.projects-v2-status') return { data: { status: accountModule } };
      throw new Error(`onverwacht endpoint in test: ${endpoint}`);
    },
    listAll: async (endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === 'projects.list') {
        if (accountModule !== 'legacy') throw noAccess(endpoint);
        return [];
      }
      if (endpoint === 'projects-v2/projects.list') {
        if (accountModule !== 'projects-v2') throw noAccess(endpoint);
        return [];
      }
      return [];
    },
  } as unknown as TeamleaderClient;
}

describe('ProjectSyncService — verouderde projectenmodule na accountwissel (bugreport 7/10/2026)', () => {
  it('detecteert opnieuw bij een 403 en synchroniseert dan via de juiste module', async () => {
    const { prisma, connection } = createFakePrisma('LEGACY');
    const calls: string[] = [];
    const service = new ProjectSyncService(prisma, fakeClient('projects-v2', calls));

    await expect(service.syncAll()).resolves.toMatchObject({ module: 'PROJECTS_V2' });

    expect(calls).toEqual(expect.arrayContaining(['projects.list', 'accounts.projects-v2-status', 'projects-v2/projects.list']));
    expect(connection.projectsModule).toBe('PROJECTS_V2');
  });

  it('geeft een begrijpelijke fout als Teamleader de projectenmodule echt weigert (rechten/abonnement/scope)', async () => {
    const { prisma } = createFakePrisma('LEGACY');
    const client = {
      post: async () => ({ data: { status: 'legacy' } }),
      listAll: async (endpoint: string) => {
        throw new TeamleaderApiError(403, endpoint, `${endpoint} gaf 403 terug`);
      },
    } as unknown as TeamleaderClient;
    const service = new ProjectSyncService(prisma, client);

    const error = await service.syncAll().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TEAMLEADER_PROJECTS_NO_ACCESS');
  });

  it('detecteert NIET opnieuw bij een andere fout dan 403', async () => {
    const { prisma } = createFakePrisma('LEGACY');
    const calls: string[] = [];
    const client = {
      post: async (endpoint: string) => {
        calls.push(endpoint);
        return { data: { status: 'legacy' } };
      },
      listAll: async (endpoint: string) => {
        throw new TeamleaderApiError(500, endpoint, `${endpoint} gaf 500 terug`);
      },
    } as unknown as TeamleaderClient;
    const service = new ProjectSyncService(prisma, client);

    const error = await service.syncAll().catch((err: unknown) => err);
    expect((error as ApiError).code).toBe('TEAMLEADER_SYNC_FAILED');
    expect(calls).not.toContain('accounts.projects-v2-status');
  });
});

describe('ProjectSyncService — sync bij elke supervisor-login (klantvraag 7/10/2026)', () => {
  it('twee gelijktijdige syncs delen één run (geen dubbele Teamleader-aanroepen)', async () => {
    const { prisma } = createFakePrisma('PROJECTS_V2');
    const calls: string[] = [];
    const service = new ProjectSyncService(prisma, fakeClient('projects-v2', calls));

    const [first, second] = await Promise.all([service.syncAll(), service.syncAll()]);

    expect(first).toBe(second);
    expect(calls.filter((endpoint) => endpoint === 'projects-v2/projects.list')).toHaveLength(1);
  });

  it('start na afloop gewoon een nieuwe run (de gedeelde run blijft niet hangen)', async () => {
    const { prisma } = createFakePrisma('PROJECTS_V2');
    const calls: string[] = [];
    const service = new ProjectSyncService(prisma, fakeClient('projects-v2', calls));

    await service.syncAll();
    await service.syncAll();

    expect(calls.filter((endpoint) => endpoint === 'projects-v2/projects.list')).toHaveLength(2);
  });

  it('een mislukte run blokkeert de volgende niet', async () => {
    const { prisma } = createFakePrisma('PROJECTS_V2');
    let fail = true;
    const client = {
      post: async () => ({ data: { status: 'projects-v2' } }),
      listAll: async (endpoint: string) => {
        if (endpoint === 'projects-v2/projects.list' && fail) {
          throw new TeamleaderApiError(500, endpoint, `${endpoint} gaf 500 terug`);
        }
        return [];
      },
    } as unknown as TeamleaderClient;
    const service = new ProjectSyncService(prisma, client);

    await expect(service.syncAll()).rejects.toBeInstanceOf(ApiError);
    fail = false;
    await expect(service.syncAll()).resolves.toMatchObject({ module: 'PROJECTS_V2' });
  });
});
