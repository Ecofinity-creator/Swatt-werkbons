import { Prisma, type PrismaClient } from '@prisma/client';
import { ProjectErrors, TimeEntryErrors } from '../../errors';

const WITH_PROJECT = { include: { project: { include: { customer: true } } } } as const;

/** Sectie 6 — "Tijd manueel ingeven": tolereert klein klokverschil tussen telefoon en server bij de "niet in de toekomst"-controle in createManual(). */
const FUTURE_GRACE_MS = 5 * 60 * 1000;

export interface TimeEntryRecord {
  id: string;
  employeeId: string;
  projectId: string | null;
  activityType: 'PROJECT_WORK' | 'TRAVEL' | 'INTERNAL' | 'TRAINING' | 'OTHER';
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  currentPauseStartedAt: Date | null;
  description: string | null;
  isManual: boolean;
  project: {
    name: string;
    customer: { name: string };
  } | null;
}

export interface CreateManualTimeEntryInput {
  projectId: string;
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
  description: string | null;
}

export interface CorrectTimeEntryInput {
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
  description: string | null;
}

/**
 * Statussen van de gekoppelde werkbon waarbij een tijdsregistratie nog vrij
 * overschreven mag worden (sectie 4: "zolang werkbon niet definitief is").
 * Business rule (bevestigd door Steven, aug 2026): "een werkbon mag na
 * ondertekening/synchronisatie niet meer aangepast kunnen worden" — vanaf
 * SIGNED bestaat er dus GEEN correctiepad meer, ook geen aparte "correctie-
 * rij"-uitzondering. Dit is een aanscherping van business rule 3 (sectie 24):
 * "een ondertekende werkbon is immutable" gold al voor de werkbon zelf, hier
 * expliciet doorgetrokken naar de onderliggende tijdsregistraties.
 */
const WORK_ORDER_STATUSES_ALLOWING_DIRECT_EDIT = new Set(['DRAFT', 'READY_FOR_SIGNATURE']);

export class TimeEntryService {
  constructor(private readonly prisma: PrismaClient) {}

  async getActive(employeeId: string): Promise<TimeEntryRecord | null> {
    return this.prisma.timeEntry.findFirst({
      where: { employeeId, status: { in: ['RUNNING', 'PAUSED'] } },
      ...WITH_PROJECT,
    });
  }

  async start(employeeId: string, projectId: string): Promise<TimeEntryRecord> {
    const active = await this.getActive(employeeId);
    if (active) {
      throw TimeEntryErrors.alreadyActive();
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }

    const assignment = await this.prisma.projectAssignment.findUnique({
      where: { projectId_employeeId: { projectId, employeeId } },
    });
    if (!assignment) {
      throw ProjectErrors.notAssigned();
    }

    try {
      return await this.prisma.timeEntry.create({
        data: { employeeId, projectId, activityType: 'PROJECT_WORK', status: 'RUNNING', startedAt: new Date() },
        ...WITH_PROJECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw TimeEntryErrors.alreadyActive();
      }
      throw err;
    }
  }

  /**
   * Op vraag (4/9/2026, in het kader van de Belgische verplichte
   * urenregistratie vanaf 1/1/2027): niet elke gewerkte minuut is aan een
   * klantproject gekoppeld (verplaatsing tussen werven, interne vergadering,
   * opleiding, administratie...) — toch valt dit onder de wettelijke
   * verplichting om ALLE arbeidstijd te registreren via een objectief,
   * betrouwbaar systeem. Deze registratie doorloopt dezelfde PAUZE/STOP-flow
   * als een projectgebonden timer, maar wordt NOOIT in een werkbon
   * opgenomen (geen klant om te laten tekenen) — zie
   * WorkOrderService.create(), dat enkel timeEntryIds accepteert die al op
   * hetzelfde project + dezelfde werknemer zitten, wat voor een
   * niet-projectgebonden registratie per definitie nooit het geval is.
   */
  async startGeneral(
    employeeId: string,
    activityType: Exclude<TimeEntryRecord['activityType'], 'PROJECT_WORK'>,
    description: string | null,
  ): Promise<TimeEntryRecord> {
    const active = await this.getActive(employeeId);
    if (active) {
      throw TimeEntryErrors.alreadyActive();
    }

    try {
      return await this.prisma.timeEntry.create({
        data: { employeeId, projectId: null, activityType, status: 'RUNNING', startedAt: new Date(), description },
        ...WITH_PROJECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw TimeEntryErrors.alreadyActive();
      }
      throw err;
    }
  }

  /**
   * Sectie 6: "manueel tijd toevoegen indien toegestaan". Maakt een reeds
   * STOPPED registratie aan met een door de werknemer opgegeven vaste
   * start-/eindtijd (bv. vergeten de timer te starten) — in plaats van via de
   * START/PAUZE/STOP-flow. Doorloopt dezelfde project-/koppelingscontroles
   * als `start()`; business rule 1 ("één actieve timer") is hier niet van
   * toepassing, want de registratie is meteen STOPPED en botst dus nooit met
   * de partiële unieke index op RUNNING/PAUSED.
   *
   * Bereikcontroles (start < eind, niet in de toekomst, pauze niet langer dan
   * de periode) staan bewust HIER en niet als zod `.refine()` in
   * time-entry.schemas.ts: een ZodError wordt door de globale errorhandler
   * (sectie 27) herleid tot de generieke "De ingevoerde gegevens zijn niet
   * geldig" — via een ApiError hier komt de specifieke, mensentaal-
   * foutmelding wél bij de werknemer terecht. `FUTURE_GRACE_MS` tolereert een
   * klein klokverschil tussen telefoon en server (en het ronde uur waarop een
   * werknemer typisch afrondt) zonder meteen als "in de toekomst" te gelden.
   */
  async createManual(employeeId: string, input: CreateManualTimeEntryInput): Promise<TimeEntryRecord> {
    if (input.endedAt.getTime() <= input.startedAt.getTime()) {
      throw TimeEntryErrors.manualEndBeforeStart();
    }
    const nowWithGrace = Date.now() + FUTURE_GRACE_MS;
    if (input.startedAt.getTime() > nowWithGrace) {
      throw TimeEntryErrors.manualStartInFuture();
    }
    if (input.endedAt.getTime() > nowWithGrace) {
      throw TimeEntryErrors.manualEndInFuture();
    }
    const totalSeconds = (input.endedAt.getTime() - input.startedAt.getTime()) / 1000;
    if (input.pausedSeconds >= totalSeconds) {
      throw TimeEntryErrors.manualPauseTooLong();
    }

    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }

    const assignment = await this.prisma.projectAssignment.findUnique({
      where: { projectId_employeeId: { projectId: input.projectId, employeeId } },
    });
    if (!assignment) {
      throw ProjectErrors.notAssigned();
    }

    return this.prisma.timeEntry.create({
      data: {
        employeeId,
        projectId: input.projectId,
        status: 'STOPPED',
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        pausedSeconds: input.pausedSeconds,
        description: input.description,
        isManual: true,
      },
      ...WITH_PROJECT,
    });
  }

  async pause(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status !== 'RUNNING') {
      throw TimeEntryErrors.notRunning();
    }
    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: { status: 'PAUSED', currentPauseStartedAt: new Date() },
      ...WITH_PROJECT,
    });
  }

  async resume(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status !== 'PAUSED' || !entry.currentPauseStartedAt) {
      throw TimeEntryErrors.notPaused();
    }
    const pausedSecondsToAdd = secondsBetween(entry.currentPauseStartedAt, new Date());
    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: {
        status: 'RUNNING',
        pausedSeconds: entry.pausedSeconds + pausedSecondsToAdd,
        currentPauseStartedAt: null,
      },
      ...WITH_PROJECT,
    });
  }

  async stop(employeeId: string, timeEntryId: string, description: string | null): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status === 'STOPPED') {
      throw TimeEntryErrors.alreadyStopped();
    }

    const now = new Date();
    const extraPausedSeconds =
      entry.status === 'PAUSED' && entry.currentPauseStartedAt
        ? secondsBetween(entry.currentPauseStartedAt, now)
        : 0;

    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: {
        status: 'STOPPED',
        endedAt: now,
        pausedSeconds: entry.pausedSeconds + extraPausedSeconds,
        currentPauseStartedAt: null,
        ...(description !== null ? { description } : {}),
      },
      ...WITH_PROJECT,
    });
  }

  /**
   * Sectie 4: SUPERVISOR+ corrigeert een STOPPED registratie, maar enkel
   * zolang de gekoppelde werkbon nog DRAFT/READY_FOR_SIGNATURE is (of nog aan
   * geen enkele werkbon gekoppeld is) — "zolang werkbon niet definitief is".
   *
   * Business rule (bevestigd door Steven, aug 2026): "een werkbon mag na
   * ondertekening/synchronisatie niet meer aangepast kunnen worden" — dit is
   * een aanscherping van business rule 3 (sectie 24, "een ondertekende
   * werkbon is immutable"), hier doorgetrokken naar de tijdsregistraties
   * eronder. Vanaf SIGNED bestaat er dus bewust GEEN correctiepad meer, ook
   * geen "nieuwe rij"-uitzondering — TIME_ENTRY_CORRECTION_BLOCKED_SIGNED,
   * zonder uitzondering.
   */
  async correct(timeEntryId: string, input: CorrectTimeEntryInput): Promise<TimeEntryRecord> {
    if (input.endedAt.getTime() <= input.startedAt.getTime()) {
      throw TimeEntryErrors.correctionEndBeforeStart();
    }
    const totalSeconds = (input.endedAt.getTime() - input.startedAt.getTime()) / 1000;
    if (input.pausedSeconds >= totalSeconds) {
      throw TimeEntryErrors.correctionPauseTooLong();
    }

    const entry = await this.prisma.timeEntry.findUnique({
      where: { id: timeEntryId },
      include: { workOrderLink: { include: { workOrder: { select: { id: true, status: true } } } } },
    });
    if (!entry) {
      throw TimeEntryErrors.notFound();
    }
    if (entry.status !== 'STOPPED') {
      throw TimeEntryErrors.notStoppedYet();
    }

    const workOrder = entry.workOrderLink?.workOrder ?? null;
    const canEditDirectly = !workOrder || WORK_ORDER_STATUSES_ALLOWING_DIRECT_EDIT.has(workOrder.status);
    if (!canEditDirectly) {
      throw TimeEntryErrors.correctionBlockedSigned();
    }

    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: {
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        pausedSeconds: input.pausedSeconds,
        ...(input.description !== null ? { description: input.description } : {}),
      },
      ...WITH_PROJECT,
    });
  }

  private async findOwnedEntry(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: timeEntryId }, ...WITH_PROJECT });
    if (!entry || entry.employeeId !== employeeId) {
      throw TimeEntryErrors.notFound();
    }
    return entry;
  }

  /**
   * Op vraag (4/9/2026): "Mijn werkbonnen" toont enkel klant-werkbonnen — een
   * niet-projectgebonden registratie hoort daar niet thuis (geen klant), maar
   * moet niettemin voor de werknemer zelf toegankelijk/naspeurbaar blijven
   * (wettelijk vereiste: "toegankelijk systeem"). Enkel gestopte registraties
   * (een actieve staat al op het algemene-tijdregistratiescherm zelf).
   */
  async listGeneralForEmployee(employeeId: string): Promise<TimeEntryRecord[]> {
    return this.prisma.timeEntry.findMany({
      where: { employeeId, projectId: null, status: 'STOPPED' },
      orderBy: { startedAt: 'desc' },
      take: 100,
      ...WITH_PROJECT,
    });
  }
}

function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}
