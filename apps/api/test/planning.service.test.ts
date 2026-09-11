import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import {
  addDaysUtc,
  formatDateOnly,
  generateSeriesDates,
  MAX_SERIES_ROWS,
  PlanningService,
  todayDateOnly,
} from '../src/modules/planning/planning.service';

/**
 * Fase 13 (concept) — planningsmodule. Handgeschreven fake-Prisma, zelfde
 * patroon als de andere servicelaag-tests in deze map (bv.
 * invoice-batch.service.test.ts, weekly-approval.service.test.ts) — enkel de
 * queries nabootsen die PlanningService effectief gebruikt, inclusief de
 * "interactive" `$transaction(async (tx) => ...)`-vorm (roept de callback op
 * met dezelfde fake-client op, zoals Prisma dat ook doet).
 *
 * Datums zijn bewust RELATIEF t.o.v. de echte systeemklok (via
 * todayDateOnly()/addDaysUtc()) i.p.v. hardgecodeerde kalenderdata — deze
 * tests moeten op elk moment correct blijven draaien, niet enkel rond
 * 10/9/2026.
 */

interface FakeEmployee {
  id: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  isActive: boolean;
}

interface FakeProject {
  id: string;
  name: string;
  customerName: string;
  isArchivedInTl: boolean;
}

interface FakeAssignment {
  id: string;
  employeeId: string;
  projectId: string;
  date: Date;
  seriesId: string | null;
}

interface FakeSeries {
  id: string;
  employeeId: string;
  projectId: string;
  weekdays: number[];
  startDate: Date;
  endDate: Date;
  active: boolean;
}

/** Klantvraag 11/9/2026 — de ProjectAssignment die een planningtoewijzing voortaan automatisch meekoppelt. */
interface FakeProjectAssignment {
  id: string;
  projectId: string;
  employeeId: string;
  assignedByUserId: string;
}

function inDateRange(date: Date, where: { gte?: Date; lte?: Date } | Date | undefined): boolean {
  if (where === undefined) return true;
  if (where instanceof Date) return date.getTime() === where.getTime();
  if (where.gte && date.getTime() < where.gte.getTime()) return false;
  if (where.lte && date.getTime() > where.lte.getTime()) return false;
  return true;
}

function createFakePrisma() {
  const employees: FakeEmployee[] = [
    { id: 'emp-peter', displayName: 'Peter Verlinden', employmentType: 'EMPLOYEE', isActive: true },
    { id: 'emp-sofie', displayName: 'Sofie Maes', employmentType: 'EMPLOYEE', isActive: true },
    { id: 'emp-inactive', displayName: 'Oud-medewerker', employmentType: 'EMPLOYEE', isActive: false },
  ];
  const projects: FakeProject[] = [
    { id: 'proj-janssens', name: 'Onderhoud warmtepomp', customerName: 'Janssens BV', isArchivedInTl: false },
    { id: 'proj-desmet', name: 'Service HVAC', customerName: 'De Smet NV', isArchivedInTl: false },
    { id: 'proj-archived', name: 'Oud project', customerName: 'Ex-klant', isArchivedInTl: true },
  ];
  const assignments: FakeAssignment[] = [];
  const series: FakeSeries[] = [];
  const projectAssignments: FakeProjectAssignment[] = [];
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  function toAssignmentWithIncludes(a: FakeAssignment) {
    const employee = employees.find((e) => e.id === a.employeeId);
    const project = projects.find((p) => p.id === a.projectId);
    return {
      ...a,
      employee: { displayName: employee?.displayName ?? '???' },
      project: { name: project?.name ?? '???', customer: { name: project?.customerName ?? '???' } },
    };
  }

  function toSeriesWithIncludes(s: FakeSeries) {
    const employee = employees.find((e) => e.id === s.employeeId);
    const project = projects.find((p) => p.id === s.projectId);
    return {
      ...s,
      employee: { displayName: employee?.displayName ?? '???' },
      project: { name: project?.name ?? '???', customer: { name: project?.customerName ?? '???' } },
    };
  }

  const fake = {
    employee: {
      findMany: async ({ where }: { where?: { user?: { isActive?: boolean } } } = {}) => {
        const wantActive = where?.user?.isActive;
        return employees
          .filter((e) => (wantActive === undefined ? true : e.isActive === wantActive))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((e) => ({ id: e.id, displayName: e.displayName, employmentType: e.employmentType }));
      },
      findUnique: async ({ where }: { where: { id: string } }) => employees.find((e) => e.id === where.id) ?? null,
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.find((p) => p.id === where.id) ?? null,
    },
    projectAssignment: {
      upsert: async ({
        where,
        create,
      }: {
        where: { projectId_employeeId: { projectId: string; employeeId: string } };
        create: Omit<FakeProjectAssignment, 'id'>;
        update: Record<string, never>;
      }) => {
        const existing = projectAssignments.find(
          (a) => a.projectId === where.projectId_employeeId.projectId && a.employeeId === where.projectId_employeeId.employeeId,
        );
        if (existing) return existing;
        const created: FakeProjectAssignment = { id: genId('assign'), ...create };
        projectAssignments.push(created);
        return created;
      },
    },
    planningAssignment: {
      findMany: async ({ where }: { where: { employeeId?: string; seriesId?: string; date?: { gte?: Date; lte?: Date } } }) => {
        return assignments
          .filter((a) => (where.employeeId ? a.employeeId === where.employeeId : true))
          .filter((a) => (where.seriesId ? a.seriesId === where.seriesId : true))
          .filter((a) => inDateRange(a.date, where.date))
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .map(toAssignmentWithIncludes);
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { employeeId_date: { employeeId: string; date: Date } };
        create: Omit<FakeAssignment, 'id'>;
        update: Partial<FakeAssignment>;
      }) => {
        const existing = assignments.find(
          (a) => a.employeeId === where.employeeId_date.employeeId && a.date.getTime() === where.employeeId_date.date.getTime(),
        );
        if (existing) {
          Object.assign(existing, update);
          return toAssignmentWithIncludes(existing);
        }
        const created: FakeAssignment = { id: genId('pa'), ...create };
        assignments.push(created);
        return toAssignmentWithIncludes(created);
      },
      deleteMany: async ({ where }: { where: { employeeId?: string; date?: Date | { gte?: Date }; seriesId?: string } }) => {
        const before = assignments.length;
        for (let i = assignments.length - 1; i >= 0; i -= 1) {
          const a = assignments[i]!;
          const matchesEmployee = where.employeeId ? a.employeeId === where.employeeId : true;
          const matchesSeries = where.seriesId ? a.seriesId === where.seriesId : true;
          const matchesDate = inDateRange(a.date, where.date);
          if (matchesEmployee && matchesSeries && matchesDate) {
            assignments.splice(i, 1);
          }
        }
        return { count: before - assignments.length };
      },
    },
    planningSeries: {
      create: async ({ data }: { data: Omit<FakeSeries, 'id' | 'active'> }) => {
        const created: FakeSeries = { id: genId('series'), active: true, ...data };
        series.push(created);
        return toSeriesWithIncludes(created);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = series.find((s) => s.id === where.id);
        return found ? { ...found } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeSeries> }) => {
        const found = series.find((s) => s.id === where.id);
        if (!found) throw new Error('not found');
        Object.assign(found, data);
        return { ...found };
      },
      findMany: async ({ where }: { where: { active?: boolean; endDate?: { gte?: Date } } }) => {
        return series
          .filter((s) => (where.active === undefined ? true : s.active === where.active))
          .filter((s) => inDateRange(s.endDate, where.endDate))
          .map(toSeriesWithIncludes);
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
  };

  return { prisma: fake as unknown as PrismaClient, assignments, series, projectAssignments };
}

describe('PlanningService', () => {
  describe('setAssignment', () => {
    it('maakt een nieuwe losse toewijzing aan', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      const assignment = await service.setAssignment({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        date: today,
        createdById: 'user-admin',
      });

      expect(assignment.projectId).toBe('proj-janssens');
      expect(assignment.seriesId).toBeNull();
    });

    it('overschrijft een bestaande toewijzing op dezelfde dag (business rule 11)', async () => {
      const { prisma, assignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      await service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-janssens', date: today, createdById: 'u1' });
      await service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-desmet', date: today, createdById: 'u1' });

      const peterRows = assignments.filter((a) => a.employeeId === 'emp-peter');
      expect(peterRows).toHaveLength(1);
      expect(peterRows[0]?.projectId).toBe('proj-desmet');
    });

    it('koppelt een dag altijd los van een reeks bij een individuele toewijzing (business rule 16)', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();
      const wednesdayIsh = addDaysUtc(today, 7); // ruim in de toekomst, weekdag maakt hier niet uit

      const { series } = await service.createSeries({
        employeeId: 'emp-sofie',
        projectId: 'proj-janssens',
        weekdays: [0, 1, 2, 3, 4, 5, 6], // elke dag, zodat de reeks zeker `wednesdayIsh` bevat
        startDate: formatDateOnly(today),
        endDate: formatDateOnly(addDaysUtc(today, 21)),
        createdById: 'u1',
      });

      const updated = await service.setAssignment({
        employeeId: 'emp-sofie',
        projectId: 'proj-desmet',
        date: formatDateOnly(wednesdayIsh),
        createdById: 'u1',
      });

      expect(updated.seriesId).toBeNull();
      expect(updated.projectId).toBe('proj-desmet');
      expect(series.active).toBe(true); // de reeks zelf blijft ongemoeid, enkel deze ene dag is losgekoppeld
    });

    it('weigert een onbestaande medewerker of project', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      await expect(
        service.setAssignment({ employeeId: 'geen-bestaand-id', projectId: 'proj-janssens', date: today, createdById: 'u1' }),
      ).rejects.toMatchObject({ code: 'PLANNING_EMPLOYEE_NOT_FOUND' });

      await expect(
        service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-archived', date: today, createdById: 'u1' }),
      ).rejects.toMatchObject({ code: 'PLANNING_PROJECT_NOT_FOUND' });
    });

    // Klantvraag 11/9/2026: "ik krijg nog steeds de keuze uit de projecten
    // waaraan ik toegewezen ben en niet wat er in de planning staat" — een
    // planningtoewijzing moet voortaan meteen ook de echte autorisatie
    // (ProjectAssignment) meekoppelen, anders blijft de app stil terugvallen
    // op de gewone keuzelijst (en kan de medewerker sowieso niet starten).
    it('koppelt automatisch een ProjectAssignment (autorisatie) wanneer die nog ontbreekt', async () => {
      const { prisma, projectAssignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      expect(projectAssignments).toHaveLength(0);

      await service.setAssignment({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        date: today,
        createdById: 'user-supervisor',
      });

      expect(projectAssignments).toHaveLength(1);
      expect(projectAssignments[0]).toMatchObject({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        assignedByUserId: 'user-supervisor',
      });
    });

    it('dupliceert géén ProjectAssignment die al bestaat', async () => {
      const { prisma, projectAssignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await service.setAssignment({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        date: formatDateOnly(today),
        createdById: 'u1',
      });
      // Zelfde medewerker/project, andere dag — mag geen tweede rij geven.
      await service.setAssignment({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        date: formatDateOnly(addDaysUtc(today, 1)),
        createdById: 'u1',
      });

      expect(projectAssignments.filter((a) => a.employeeId === 'emp-peter' && a.projectId === 'proj-janssens')).toHaveLength(1);
    });
  });

  describe('clearAssignment', () => {
    it('wist enkel de opgegeven dag, andere dagen van dezelfde reeks blijven staan', async () => {
      const { prisma, assignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await service.createSeries({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startDate: formatDateOnly(today),
        endDate: formatDateOnly(addDaysUtc(today, 4)),
        createdById: 'u1',
      });
      expect(assignments).toHaveLength(5);

      await service.clearAssignment({ employeeId: 'emp-peter', date: formatDateOnly(today) });

      expect(assignments).toHaveLength(4);
      expect(assignments.some((a) => a.date.getTime() === today.getTime())).toBe(false);
    });

    it('trekt de automatisch gekoppelde ProjectAssignment NIET in — enkel de planningdag zelf verdwijnt', async () => {
      const { prisma, projectAssignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await service.setAssignment({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        date: formatDateOnly(today),
        createdById: 'u1',
      });
      expect(projectAssignments).toHaveLength(1);

      await service.clearAssignment({ employeeId: 'emp-peter', date: formatDateOnly(today) });

      expect(projectAssignments).toHaveLength(1); // ongewijzigd — expliciet loskoppelen blijft een aparte actie
    });
  });

  describe('createSeries', () => {
    it('genereert enkel toewijzingen op de geselecteerde dagen, binnen de periode', async () => {
      const { prisma, assignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      const { series, generatedCount } = await service.createSeries({
        employeeId: 'emp-sofie',
        projectId: 'proj-janssens',
        weekdays: [0, 4], // maandag + vrijdag
        startDate: formatDateOnly(today),
        endDate: formatDateOnly(addDaysUtc(today, 13)), // 2 volle weken
        createdById: 'u1',
      });

      expect(generatedCount).toBe(assignments.length);
      for (const a of assignments) {
        const weekday = (a.date.getUTCDay() + 6) % 7;
        expect([0, 4]).toContain(weekday);
      }
      expect(series.weekdays).toEqual([0, 4]);
    });

    it('koppelt automatisch één ProjectAssignment voor de hele reeks (niet één per gegenereerde dag)', async () => {
      const { prisma, projectAssignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await service.createSeries({
        employeeId: 'emp-sofie',
        projectId: 'proj-janssens',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startDate: formatDateOnly(today),
        endDate: formatDateOnly(addDaysUtc(today, 13)),
        createdById: 'user-supervisor',
      });

      const forSofie = projectAssignments.filter((a) => a.employeeId === 'emp-sofie' && a.projectId === 'proj-janssens');
      expect(forSofie).toHaveLength(1);
      expect(forSofie[0]?.assignedByUserId).toBe('user-supervisor');
    });

    it('weigert een lege dagselectie', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      await expect(
        service.createSeries({
          employeeId: 'emp-peter',
          projectId: 'proj-janssens',
          weekdays: [],
          startDate: today,
          endDate: today,
          createdById: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'PLANNING_NO_WEEKDAYS_SELECTED' });
    });

    it('weigert een ongeldige weekdag', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      await expect(
        service.createSeries({
          employeeId: 'emp-peter',
          projectId: 'proj-janssens',
          weekdays: [7],
          startDate: today,
          endDate: today,
          createdById: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'PLANNING_INVALID_WEEKDAY' });
    });

    it('weigert een einddatum vóór de startdatum', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await expect(
        service.createSeries({
          employeeId: 'emp-peter',
          projectId: 'proj-janssens',
          weekdays: [0],
          startDate: formatDateOnly(today),
          endDate: formatDateOnly(addDaysUtc(today, -1)),
          createdById: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'PLANNING_END_BEFORE_START' });
    });
  });

  describe('stopSeries', () => {
    it('verwijdert enkel nog niet-verstreken toewijzingen, historiek blijft staan (business rule 15)', async () => {
      const { prisma, assignments } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      // Reeks die al een week vóór vandaag begon en nog een week doorloopt —
      // zo bevat ze zowel verleden als toekomst t.o.v. "vandaag".
      const { series } = await service.createSeries({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startDate: formatDateOnly(addDaysUtc(today, -7)),
        endDate: formatDateOnly(addDaysUtc(today, 7)),
        createdById: 'u1',
      });
      const totalBefore = assignments.length;
      expect(totalBefore).toBe(15); // 7 dagen verleden + vandaag + 7 dagen toekomst

      await service.stopSeries(series.id);

      const remaining = assignments.filter((a) => a.employeeId === 'emp-peter');
      expect(remaining.every((a) => a.date.getTime() < today.getTime())).toBe(true);
      expect(remaining).toHaveLength(7); // enkel de 7 dagen strikt vóór vandaag blijven staan

      const stopped = await prisma.planningSeries.findUnique({ where: { id: series.id } });
      expect(stopped?.active).toBe(false);
    });

    it('is idempotent — een tweede keer stopzetten geeft gewoon succes', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = formatDateOnly(todayDateOnly());

      const { series } = await service.createSeries({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startDate: today,
        endDate: today,
        createdById: 'u1',
      });

      await service.stopSeries(series.id);
      await expect(service.stopSeries(series.id)).resolves.toBeUndefined();
    });

    it('gooit een duidelijke fout voor een onbestaande reeks', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);

      await expect(service.stopSeries('onbestaand-id')).rejects.toMatchObject({
        code: 'PLANNING_SERIES_NOT_FOUND',
      });
    });
  });

  describe('listActiveSeries', () => {
    it('toont enkel actieve reeksen die nog niet volledig verstreken zijn', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      const { series: futureSeries } = await service.createSeries({
        employeeId: 'emp-peter',
        projectId: 'proj-janssens',
        weekdays: [0],
        startDate: formatDateOnly(today),
        endDate: formatDateOnly(addDaysUtc(today, 30)),
        createdById: 'u1',
      });
      const { series: pastSeries } = await service.createSeries({
        employeeId: 'emp-sofie',
        projectId: 'proj-desmet',
        weekdays: [0],
        startDate: formatDateOnly(addDaysUtc(today, -30)),
        endDate: formatDateOnly(addDaysUtc(today, -1)),
        createdById: 'u1',
      });

      const active = await service.listActiveSeries();
      const ids = active.map((s) => s.id);
      expect(ids).toContain(futureSeries.id);
      expect(ids).not.toContain(pastSeries.id);
    });
  });

  describe('listForEmployee ("Mijn planning")', () => {
    it('geeft enkel de eigen toewijzingen vanaf vandaag terug', async () => {
      const { prisma } = createFakePrisma();
      const service = new PlanningService(prisma);
      const today = todayDateOnly();

      await service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-janssens', date: formatDateOnly(addDaysUtc(today, -1)), createdById: 'u1' });
      await service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-desmet', date: formatDateOnly(today), createdById: 'u1' });
      await service.setAssignment({ employeeId: 'emp-peter', projectId: 'proj-janssens', date: formatDateOnly(addDaysUtc(today, 3)), createdById: 'u1' });
      await service.setAssignment({ employeeId: 'emp-sofie', projectId: 'proj-desmet', date: formatDateOnly(today), createdById: 'u1' });

      const mine = await service.listForEmployee('emp-peter', 7);

      expect(mine).toHaveLength(2); // vandaag + over 3 dagen; gisteren valt buiten het venster
      expect(mine.every((a) => a.employeeId === 'emp-peter')).toBe(true);
    });
  });

  describe('generateSeriesDates (MVP-veiligheidsgrens)', () => {
    it('stopt bij MAX_SERIES_ROWS, ook bij "elke dag" over een zeer lange periode', () => {
      const today = todayDateOnly();
      const farFuture = addDaysUtc(today, 1000);

      const dates = generateSeriesDates(today, farFuture, [0, 1, 2, 3, 4, 5, 6]);

      expect(dates.length).toBeLessThanOrEqual(MAX_SERIES_ROWS);
      expect(dates.length).toBeGreaterThan(0);
    });
  });
});
