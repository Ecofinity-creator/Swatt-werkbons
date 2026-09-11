import type { Prisma, PrismaClient } from '@prisma/client';
import { PlanningErrors } from '../../errors';

/**
 * Fase 13 (concept) — planningsmodule/dispatch. Zie
 * claude/phase13-planningsmodule-concept.md (project-documentatie) voor de
 * volledige functionele/technische toelichting, en PlanningSeries/
 * PlanningAssignment in schema.prisma voor het datamodel zelf.
 *
 * MVP-grenzen (zelfde als in de meegeleverde klant-mockup): een reeks
 * genereert bij aanmaak meteen alle onderliggende dagrijen (tot max.
 * MAX_SERIES_ROWS dagen, over een periode van max. MAX_SERIES_SPAN_DAYS
 * kalenderdagen) — dit houdt "wat is het project van medewerker X vandaag"
 * een simpele, snelle query i.p.v. het herhalingspatroon telkens te
 * herinterpreteren, en laat toe dat één dag binnen een reeks achteraf apart
 * gewijzigd/gewist wordt zonder de rest te raken (die dag verliest dan
 * gewoon zijn seriesId — business rule 16).
 */
export class PlanningService {
  constructor(private readonly prisma: PrismaClient) {}

  async listEmployees(): Promise<PlanningEmployeeRecord[]> {
    return this.prisma.employee.findMany({
      where: { user: { isActive: true } },
      select: { id: true, displayName: true, employmentType: true },
      orderBy: { displayName: 'asc' },
    });
  }

  async listWeek(weekStartIso: string): Promise<PlanningAssignmentRecord[]> {
    const weekStart = parseDateOnly(weekStartIso);
    const weekEnd = addDaysUtc(weekStart, 6);
    return this.findAssignments({ date: { gte: weekStart, lte: weekEnd } });
  }

  /** Enkel actieve, nog niet-verstreken reeksen — zie ListPlanningSeriesResponseBody. */
  async listActiveSeries(): Promise<PlanningSeriesRecord[]> {
    const today = todayDateOnly();
    return this.prisma.planningSeries.findMany({
      where: { active: true, endDate: { gte: today } },
      include: { employee: true, project: { include: { customer: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForEmployee(employeeId: string, days: number): Promise<PlanningAssignmentRecord[]> {
    const start = todayDateOnly();
    const end = addDaysUtc(start, Math.max(days - 1, 0));
    return this.findAssignments({ employeeId, date: { gte: start, lte: end } });
  }

  /**
   * Wijst één dag toe — overschrijft een eventuele bestaande toewijzing op
   * diezelfde dag (business rule 11: max. 1 per medewerker/dag) en koppelt
   * die dag altijd los van een eventuele reeks (business rule 16: een
   * expliciete, individuele toewijzing wint altijd van reeks-lidmaatschap).
   */
  async setAssignment(input: {
    employeeId: string;
    projectId: string;
    date: string;
    createdById: string;
  }): Promise<PlanningAssignmentRecord> {
    await this.assertEmployeeExists(input.employeeId);
    await this.assertProjectExists(input.projectId);
    const date = parseDateOnly(input.date);

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.ensureProjectAssignment(tx, input.employeeId, input.projectId, input.createdById);

      return tx.planningAssignment.upsert({
        where: { employeeId_date: { employeeId: input.employeeId, date } },
        create: {
          employeeId: input.employeeId,
          projectId: input.projectId,
          date,
          seriesId: null,
          createdById: input.createdById,
        },
        update: {
          projectId: input.projectId,
          seriesId: null,
          createdById: input.createdById,
        },
        include: { employee: true, project: { include: { customer: true } } },
      });
    });
  }

  /** Wist enkel deze ene dag — een eventuele reeks blijft voor de overige dagen gewoon bestaan. */
  async clearAssignment(input: { employeeId: string; date: string }): Promise<void> {
    const date = parseDateOnly(input.date);
    await this.prisma.planningAssignment.deleteMany({ where: { employeeId: input.employeeId, date } });
  }

  /**
   * Klantvraag 10/9/2026: niet enkel één vaste weekdag, maar een vrije
   * combinatie ("hele week", "elke dag", of eender welke selectie) —
   * `weekdays` is dus een array, gevalideerd op minstens 1 element door het
   * zod-schema; hier enkel nog de business-controles (bereik, periode, grens).
   */
  async createSeries(input: {
    employeeId: string;
    projectId: string;
    weekdays: number[];
    startDate: string;
    endDate: string;
    createdById: string;
  }): Promise<{ series: PlanningSeriesRecord; generatedCount: number }> {
    await this.assertEmployeeExists(input.employeeId);
    await this.assertProjectExists(input.projectId);

    const uniqueWeekdays = Array.from(new Set(input.weekdays));
    if (uniqueWeekdays.length === 0) {
      throw PlanningErrors.noWeekdaysSelected();
    }
    if (uniqueWeekdays.some((day) => day < 0 || day > 6)) {
      throw PlanningErrors.invalidWeekday();
    }

    const startDate = parseDateOnly(input.startDate);
    const endDate = parseDateOnly(input.endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw PlanningErrors.endBeforeStart();
    }

    const occurrences = generateSeriesDates(startDate, endDate, uniqueWeekdays);
    // Kan enkel voorkomen wanneer de gekozen periode de MVP-grens overschrijdt
    // vóór er ook maar 1 geldige dag gevonden is — zeer onwaarschijnlijk in de
    // praktijk (zou een periode van >400 dagen vereisen), maar defensief
    // afgevangen i.p.v. stilzwijgend een lege reeks aan te maken.
    if (occurrences.length === 0) {
      throw PlanningErrors.seriesTooLong();
    }

    // `Prisma.TransactionClient` is de officiële typering hiervoor — in deze
    // sandbox (niet-geregenereerde Prisma-client, zie hierboven) valt die
    // helaas terug op `any`, maar dat is de library's eigen typedefinitie,
    // geen losse `any` van onzentwege.
    const series = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.ensureProjectAssignment(tx, input.employeeId, input.projectId, input.createdById);

      const createdSeries = await tx.planningSeries.create({
        data: {
          employeeId: input.employeeId,
          projectId: input.projectId,
          weekdays: uniqueWeekdays,
          startDate,
          endDate,
          createdById: input.createdById,
        },
        include: { employee: true, project: { include: { customer: true } } },
      });

      // Overschrijft bewust bestaande toewijzingen op deze data (business
      // rule 11) — de reeks is vanaf aanmaak de nieuwe bron van waarheid voor
      // deze dagen, net als in de meegeleverde mockup.
      for (const occurrence of occurrences) {
        await tx.planningAssignment.upsert({
          where: { employeeId_date: { employeeId: input.employeeId, date: occurrence } },
          create: {
            employeeId: input.employeeId,
            projectId: input.projectId,
            date: occurrence,
            seriesId: createdSeries.id,
            createdById: input.createdById,
          },
          update: {
            projectId: input.projectId,
            seriesId: createdSeries.id,
            createdById: input.createdById,
          },
        });
      }

      return createdSeries;
    });

    return { series, generatedCount: occurrences.length };
  }

  /**
   * Zet een reeks stop — verwijdert enkel nog niet-verstreken toewijzingen
   * (business rule 15: historiek/audit blijft correct, al gepasseerde dagen
   * blijven staan). Idempotent: een reeds gestopte reeks geeft gewoon succes.
   */
  async stopSeries(seriesId: string): Promise<void> {
    const series = await this.prisma.planningSeries.findUnique({ where: { id: seriesId } });
    if (!series) {
      throw PlanningErrors.seriesNotFound();
    }
    if (!series.active) {
      return;
    }

    const today = todayDateOnly();
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.planningSeries.update({ where: { id: seriesId }, data: { active: false } });
      await tx.planningAssignment.deleteMany({ where: { seriesId, date: { gte: today } } });
    });
  }

  private async findAssignments(where: Record<string, unknown>): Promise<PlanningAssignmentRecord[]> {
    return this.prisma.planningAssignment.findMany({
      where,
      include: { employee: true, project: { include: { customer: true } } },
      orderBy: { date: 'asc' },
    });
  }

  private async assertEmployeeExists(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      throw PlanningErrors.employeeNotFound();
    }
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw PlanningErrors.projectNotFound();
    }
  }

  /**
   * Klantvraag 11/9/2026: "ik krijg nog steeds de keuze uit de projecten
   * waaraan ik toegewezen ben en niet wat er in de planning staat." Oorzaak:
   * een planningtoewijzing (dit bestand) gaf voorheen GEEN automatische
   * `ProjectAssignment` (Fase 3 — de eigenlijke autorisatie om een timer te
   * starten, zie `TimeEntryService.start()`/`addManual()`, die zonder een
   * `ProjectAssignment`-rij hard weigert met `ProjectErrors.notAssigned()`).
   * Stond een medewerker dus nog niet apart gekoppeld aan het project via
   * "Projecten aan medewerker koppelen", dan verscheen de ingeplande opdracht
   * op de app nergens (de rule-12-veiligheidscheck op HomePage.tsx/
   * EmployeeProjectsPage.tsx viel stil terug op de gewone lijst) én kon de
   * medewerker hem sowieso niet starten, ook niet via die gewone lijst.
   *
   * Een planningtoewijzing impliceert dus voortaan meteen ook de
   * `ProjectAssignment` — de supervisor plant het werk één keer, op het
   * planningsbord, en dat volstaat. Bewust enkel TOEVOEGEN, nooit
   * automatisch verwijderen: een dag uit de planning wissen of een reeks
   * stopzetten mag een bestaande, mogelijk voor andere dagen/doeleinden
   * gebruikte projectkoppeling niet stilzwijgend intrekken (zelfde
   * voorzichtigheidsprincipe als business rules 8/9 — wijzigingen mogen
   * afgeleide/lokale autorisatie nooit ongevraagd beschadigen). Expliciet
   * loskoppelen blijft mogelijk via de bestaande "Projecten aan medewerker
   * koppelen"-beheerpagina.
   */
  private async ensureProjectAssignment(
    tx: Prisma.TransactionClient,
    employeeId: string,
    projectId: string,
    assignedByUserId: string,
  ): Promise<void> {
    await tx.projectAssignment.upsert({
      where: { projectId_employeeId: { projectId, employeeId } },
      create: { projectId, employeeId, assignedByUserId },
      update: {},
    });
  }
}

// ---- Structurele record-types (zelfde patroon als elders, bv. project.routes.ts's toProjectSummary) ----

export interface PlanningEmployeeRecord {
  id: string;
  displayName: string;
  employmentType: 'EMPLOYEE' | 'SUBCONTRACTOR';
}

export interface PlanningAssignmentRecord {
  id: string;
  employeeId: string;
  projectId: string;
  date: Date;
  seriesId: string | null;
  employee: { displayName: string };
  project: { name: string; customer: { name: string } };
}

export interface PlanningSeriesRecord {
  id: string;
  employeeId: string;
  projectId: string;
  weekdays: number[];
  startDate: Date;
  endDate: Date;
  active: boolean;
  employee: { displayName: string };
  project: { name: string; customer: { name: string } };
}

// ---- Datumhulpfuncties (date-only, UTC — zelfde aanpak als WeeklyApprovalService.weekBoundsOf) ----

/**
 * Zod valideert het JJJJ-MM-DD-formaat al vóór dit ooit aangeroepen wordt —
 * geen aparte foutafhandeling hier nodig. Vaste `slice()`-posities i.p.v.
 * `split('-').map(Number)`-destructurering: dat laatste geeft onder
 * `noUncheckedIndexedAccess` elementen van het type `number | undefined`.
 */
export function parseDateOnly(iso: string): Date {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysUtc(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** JS Date.getUTCDay(): 0=zondag..6=zaterdag → 0=maandag..6=zondag (zelfde conventie als de mockup en het datamodel). */
export function weekdayOfUtc(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** MVP-veiligheidsgrens: max. aantal gegenereerde dagen per reeks (~26 weken bij "elke dag"). */
export const MAX_SERIES_ROWS = 180;
/** Absolute grens op de doorlopen periode, los van hoeveel dagen/week gekozen zijn (~13 maanden). */
export const MAX_SERIES_SPAN_DAYS = 400;

export function generateSeriesDates(startDate: Date, endDate: Date, weekdays: number[]): Date[] {
  const weekdaySet = new Set(weekdays);
  const out: Date[] = [];
  let cursor = startDate;
  let iterated = 0;
  while (cursor.getTime() <= endDate.getTime() && out.length < MAX_SERIES_ROWS && iterated < MAX_SERIES_SPAN_DAYS) {
    if (weekdaySet.has(weekdayOfUtc(cursor))) {
      out.push(cursor);
    }
    cursor = addDaysUtc(cursor, 1);
    iterated += 1;
  }
  return out;
}
