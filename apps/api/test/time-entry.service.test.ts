import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeEntryService } from '../src/modules/time-entries/time-entry.service';

/**
 * Unit-tests met een minimale fake-Prisma (geen echte database/gegenereerde
 * client nodig — zelfde patroon als teamleader-auth.service.test.ts). Dekt de
 * kritieke business rules uit sectie 24 van de projectbrief: "één werknemer
 * kan maar één actieve timer hebben" en de pauze/hervat-tijdrekenkunde
 * (regel 2: een timer moet altijd aan een project gekoppeld zijn, afgedwongen
 * doordat `start()` een verplichte projectId-parameter heeft — er bestaat
 * geen enkel pad om een TimeEntry zonder project aan te maken).
 */

interface FakeProject {
  id: string;
  isArchivedInTl: boolean;
  name: string;
  customerName: string;
}

interface FakeTimeEntry {
  id: string;
  employeeId: string;
  projectId: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  currentPauseStartedAt: Date | null;
  description: string | null;
  isManual: boolean;
}

function createFakePrisma(options: { projects?: FakeProject[]; assignments?: Array<[string, string]> } = {}) {
  const projects = new Map((options.projects ?? []).map((p) => [p.id, p]));
  const assignments = new Set((options.assignments ?? []).map(([projectId, employeeId]) => `${projectId}:${employeeId}`));
  const entries = new Map<string, FakeTimeEntry>();
  let idCounter = 0;

  function toRecord(entry: FakeTimeEntry) {
    const project = projects.get(entry.projectId);
    return {
      ...entry,
      project: { name: project?.name ?? 'Onbekend project', customer: { name: project?.customerName ?? 'Onbekende klant' } },
    };
  }

  const timeEntry = {
    findFirst: vi.fn(async ({ where }: { where: { employeeId: string; status: { in: string[] } } }) => {
      const found = [...entries.values()].find(
        (e) => e.employeeId === where.employeeId && where.status.in.includes(e.status),
      );
      return found ? toRecord(found) : null;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = entries.get(where.id);
      return found ? toRecord(found) : null;
    }),
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          employeeId: string;
          projectId: string;
          status: 'RUNNING' | 'STOPPED';
          startedAt: Date;
          endedAt?: Date | null;
          pausedSeconds?: number;
          description?: string | null;
          isManual?: boolean;
        };
      }) => {
        const id = `entry-${++idCounter}`;
        const entry: FakeTimeEntry = {
          id,
          employeeId: data.employeeId,
          projectId: data.projectId,
          status: data.status,
          startedAt: data.startedAt,
          endedAt: data.endedAt ?? null,
          pausedSeconds: data.pausedSeconds ?? 0,
          currentPauseStartedAt: null,
          description: data.description ?? null,
          isManual: data.isManual ?? false,
        };
        entries.set(id, entry);
        return toRecord(entry);
      },
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeTimeEntry> }) => {
      const existing = entries.get(where.id);
      if (!existing) throw new Error('geen rij om te updaten in de fake-Prisma');
      const updated = { ...existing, ...data };
      entries.set(where.id, updated);
      return toRecord(updated);
    }),
  };

  const project = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null),
  };

  const projectAssignment = {
    findUnique: vi.fn(
      async ({ where }: { where: { projectId_employeeId: { projectId: string; employeeId: string } } }) => {
        const key = `${where.projectId_employeeId.projectId}:${where.projectId_employeeId.employeeId}`;
        return assignments.has(key) ? { id: 'assignment-fake' } : null;
      },
    ),
  };

  return { prisma: { timeEntry, project, projectAssignment } as unknown as PrismaClient };
}

const PROJECT: FakeProject = { id: 'project-1', isArchivedInTl: false, name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' };

describe('TimeEntryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T08:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() maakt een RUNNING-registratie aan wanneer het project bestaat en aan de werknemer gekoppeld is', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    const entry = await service.start('employee-1', 'project-1');

    expect(entry.status).toBe('RUNNING');
    expect(entry.employeeId).toBe('employee-1');
    expect(entry.projectId).toBe('project-1');
    expect(entry.project).toEqual({ name: 'Onderhoud warmtepomp', customer: { name: 'Janssens BV' } });
    expect(entry.pausedSeconds).toBe(0);
    expect(entry.currentPauseStartedAt).toBeNull();
  });

  it('start() weigert met TIME_ENTRY_ALREADY_ACTIVE wanneer de werknemer al een actieve registratie heeft', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    await service.start('employee-1', 'project-1');

    await expect(service.start('employee-1', 'project-1')).rejects.toMatchObject({
      code: 'TIME_ENTRY_ALREADY_ACTIVE',
    });
  });

  it('start() weigert met PROJECT_NOT_FOUND voor een onbestaand of gearchiveerd project', async () => {
    const { prisma } = createFakePrisma({
      projects: [{ ...PROJECT, id: 'project-archived', isArchivedInTl: true }],
      assignments: [['project-archived', 'employee-1']],
    });
    const service = new TimeEntryService(prisma);

    await expect(service.start('employee-1', 'project-onbestaand')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(service.start('employee-1', 'project-archived')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('start() weigert met PROJECT_NOT_ASSIGNED wanneer het project bestaat maar niet aan de werknemer gekoppeld is', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [] });
    const service = new TimeEntryService(prisma);

    await expect(service.start('employee-1', 'project-1')).rejects.toMatchObject({
      code: 'PROJECT_NOT_ASSIGNED',
    });
  });

  it('createManual() maakt meteen een STOPPED registratie aan met de opgegeven periode en isManual=true', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    const entry = await service.createManual('employee-1', {
      projectId: 'project-1',
      startedAt: new Date('2026-08-22T08:00:00Z'),
      endedAt: new Date('2026-08-22T12:00:00Z'),
      pausedSeconds: 30 * 60,
      description: 'Vergeten de timer te starten.',
    });

    expect(entry.status).toBe('STOPPED');
    expect(entry.isManual).toBe(true);
    expect(entry.startedAt).toEqual(new Date('2026-08-22T08:00:00Z'));
    expect(entry.endedAt).toEqual(new Date('2026-08-22T12:00:00Z'));
    expect(entry.pausedSeconds).toBe(30 * 60);
    expect(entry.description).toBe('Vergeten de timer te starten.');
  });

  it('createManual() weigert wanneer de eindtijd niet na de starttijd ligt', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    await expect(
      service.createManual('employee-1', {
        projectId: 'project-1',
        startedAt: new Date('2026-08-22T12:00:00Z'),
        endedAt: new Date('2026-08-22T08:00:00Z'),
        pausedSeconds: 0,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_MANUAL_END_BEFORE_START' });
  });

  it('createManual() weigert een start- of eindtijd in de toekomst', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(
      service.createManual('employee-1', {
        projectId: 'project-1',
        startedAt: farFuture,
        endedAt: new Date(farFuture.getTime() + 60 * 60 * 1000),
        pausedSeconds: 0,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_MANUAL_START_IN_FUTURE' });

    await expect(
      service.createManual('employee-1', {
        projectId: 'project-1',
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endedAt: farFuture,
        pausedSeconds: 0,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_MANUAL_END_IN_FUTURE' });
  });

  it('createManual() tolereert een kort klokverschil (grace period) rond het huidige moment', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    // 3 minuten "in de toekomst" — binnen de grace period, mag dus niet weigeren.
    const entry = await service.createManual('employee-1', {
      projectId: 'project-1',
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      endedAt: new Date(Date.now() + 3 * 60 * 1000),
      pausedSeconds: 0,
      description: null,
    });

    expect(entry.status).toBe('STOPPED');
  });

  it('createManual() weigert een pauze die even lang of langer is dan de volledige periode', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);

    await expect(
      service.createManual('employee-1', {
        projectId: 'project-1',
        startedAt: new Date('2026-08-22T08:00:00Z'),
        endedAt: new Date('2026-08-22T12:00:00Z'),
        pausedSeconds: 4 * 60 * 60, // exact even lang als de periode zelf
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_MANUAL_PAUSE_TOO_LONG' });
  });

  it('createManual() weigert met PROJECT_NOT_FOUND voor een onbestaand of gearchiveerd project', async () => {
    const { prisma } = createFakePrisma({
      projects: [{ ...PROJECT, id: 'project-archived', isArchivedInTl: true }],
      assignments: [['project-archived', 'employee-1']],
    });
    const service = new TimeEntryService(prisma);
    const input = {
      projectId: 'project-archived',
      startedAt: new Date('2026-08-22T08:00:00Z'),
      endedAt: new Date('2026-08-22T12:00:00Z'),
      pausedSeconds: 0,
      description: null,
    };

    await expect(service.createManual('employee-1', { ...input, projectId: 'project-onbestaand' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(service.createManual('employee-1', input)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('createManual() weigert met PROJECT_NOT_ASSIGNED wanneer het project niet aan de werknemer gekoppeld is', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [] });
    const service = new TimeEntryService(prisma);

    await expect(
      service.createManual('employee-1', {
        projectId: 'project-1',
        startedAt: new Date('2026-08-22T08:00:00Z'),
        endedAt: new Date('2026-08-22T12:00:00Z'),
        pausedSeconds: 0,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_ASSIGNED' });
  });

  it('createManual() botst niet met business rule 1 — een actieve timer op een ander project blijft ongemoeid', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    const manual = await service.createManual('employee-1', {
      projectId: 'project-1',
      startedAt: new Date('2026-08-22T08:00:00Z'),
      endedAt: new Date('2026-08-22T12:00:00Z'),
      pausedSeconds: 0,
      description: null,
    });

    expect(manual.status).toBe('STOPPED');
    expect(manual.id).not.toBe(started.id);
    const stillActive = await service.getActive('employee-1');
    expect(stillActive?.id).toBe(started.id);
    expect(stillActive?.status).toBe('RUNNING');
  });

  it('pause() zet een lopende registratie op PAUSED en registreert het pauzemoment', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    const paused = await service.pause('employee-1', started.id);

    expect(paused.status).toBe('PAUSED');
    expect(paused.currentPauseStartedAt).toEqual(new Date('2026-08-23T08:00:00Z'));
  });

  it('pause() weigert met TIME_ENTRY_NOT_RUNNING wanneer de registratie al gepauzeerd of gestopt is', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');
    await service.pause('employee-1', started.id);

    await expect(service.pause('employee-1', started.id)).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_RUNNING' });
  });

  it('resume() telt de verstreken pauzetijd correct op bij pausedSeconds en wist currentPauseStartedAt', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    vi.setSystemTime(new Date('2026-08-23T08:10:00Z'));
    await service.pause('employee-1', started.id);

    vi.setSystemTime(new Date('2026-08-23T08:15:00Z')); // 5 minuten gepauzeerd
    const resumed = await service.resume('employee-1', started.id);

    expect(resumed.status).toBe('RUNNING');
    expect(resumed.pausedSeconds).toBe(5 * 60);
    expect(resumed.currentPauseStartedAt).toBeNull();
  });

  it('resume() weigert met TIME_ENTRY_NOT_PAUSED wanneer de registratie loopt of al gestopt is', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    await expect(service.resume('employee-1', started.id)).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_PAUSED' });
  });

  it('stop() vanuit RUNNING zet STOPPED en endedAt, pausedSeconds blijft 0', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    vi.setSystemTime(new Date('2026-08-23T10:17:00Z')); // 2u17 later
    const stopped = await service.stop('employee-1', started.id, 'Onderhoud uitgevoerd.');

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.endedAt).toEqual(new Date('2026-08-23T10:17:00Z'));
    expect(stopped.pausedSeconds).toBe(0);
    expect(stopped.description).toBe('Onderhoud uitgevoerd.');
  });

  it('stop() vanuit PAUSED telt de nog lopende pauze mee in pausedSeconds', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    vi.setSystemTime(new Date('2026-08-23T08:30:00Z'));
    await service.pause('employee-1', started.id);

    vi.setSystemTime(new Date('2026-08-23T08:33:00Z')); // nog 3 minuten gepauzeerd bij het stoppen
    const stopped = await service.stop('employee-1', started.id, null);

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.pausedSeconds).toBe(3 * 60);
    expect(stopped.currentPauseStartedAt).toBeNull();
    // Geen description meegegeven bij stop(): het bestaande (null) veld blijft behouden.
    expect(stopped.description).toBeNull();
  });

  it('stop() weigert met TIME_ENTRY_ALREADY_STOPPED bij een tweede stop-poging', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');
    await service.stop('employee-1', started.id, null);

    await expect(service.stop('employee-1', started.id, null)).rejects.toMatchObject({
      code: 'TIME_ENTRY_ALREADY_STOPPED',
    });
  });

  it('pause()/resume()/stop() weigeren met TIME_ENTRY_NOT_FOUND voor een registratie van een andere werknemer', async () => {
    const { prisma } = createFakePrisma({
      projects: [PROJECT],
      assignments: [
        ['project-1', 'employee-1'],
        ['project-1', 'employee-2'],
      ],
    });
    const service = new TimeEntryService(prisma);
    const started = await service.start('employee-1', 'project-1');

    await expect(service.pause('employee-2', started.id)).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_FOUND' });
    await expect(service.resume('employee-2', started.id)).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_FOUND' });
    await expect(service.stop('employee-2', started.id, null)).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_FOUND' });
  });

  it('start() vertaalt een unique-constraint-fout (P2002) van create() naar TIME_ENTRY_ALREADY_ACTIVE', async () => {
    // Simuleert de race condition tussen twee gelijktijdige start-aanvragen
    // voor dezelfde werknemer: de check (getActive) vond op dat moment nog
    // geen actieve registratie, maar create() zelf botst alsnog op de
    // partiële unieke index in de databank (`time_entry_one_active_per_employee`,
    // rechtstreeks geverifieerd tegen een echte Postgres bij het bouwen van
    // deze migratie) — exact wat er gebeurt bij twee requests die nagenoeg
    // gelijktijdig binnenkomen. Gebruikt een echte
    // `Prisma.PrismaClientKnownRequestError`-instantie (i.p.v. een kale
    // Error met een `.code`-veld), zodat de `instanceof`-check in
    // TimeEntryService.start() ook effectief getest wordt.
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const fakeTimeEntry = (prisma as unknown as { timeEntry: Record<string, unknown> }).timeEntry;
    fakeTimeEntry.findFirst = vi.fn(async () => null);
    fakeTimeEntry.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      });
    });
    const service = new TimeEntryService(prisma);

    await expect(service.start('employee-1', 'project-1')).rejects.toMatchObject({
      code: 'TIME_ENTRY_ALREADY_ACTIVE',
    });
  });

  it('start() geeft een andere databankfout gewoon door (geen P2002)', async () => {
    const { prisma } = createFakePrisma({ projects: [PROJECT], assignments: [['project-1', 'employee-1']] });
    const fakeTimeEntry = (prisma as unknown as { timeEntry: Record<string, unknown> }).timeEntry;
    fakeTimeEntry.findFirst = vi.fn(async () => null);
    fakeTimeEntry.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: Prisma.prismaVersion.client,
      });
    });
    const service = new TimeEntryService(prisma);

    await expect(service.start('employee-1', 'project-1')).rejects.toMatchObject({ code: 'P2003' });
  });
});
