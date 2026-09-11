import type { PrismaClient } from '@prisma/client';
import { HoursExportErrors } from '../../errors';
import { fillPersonalTimesheetTemplate } from './personal-timesheet-workbook';

/**
 * Klantvraag 10/9/2026 — "de klant wil nog een extra export mogelijkheid,
 * naar het eerste tabblad van zijn excel hier in bijlage, waar alles dan op
 * de juiste plaats ingevuld wordt". Het bijgevoegde bestand
 * ("Uren registratie 2026 leeg basis document.xlsx") is een persoonlijk
 * jaaroverzicht: 12 maandtabbladen (Jan..Dec) van telkens één rij per
 * kalenderdag, met formules die automatisch weekdag/uren/overuren/kostprijs
 * berekenen zodra de ruwe invoervelden (start/einde, pauze, km, project,
 * opmerkingen) ingevuld zijn. Zie apps/api/assets/personal-timesheet-template-2026.xlsx
 * (ongewijzigde kopie van het bijgevoegde bestand) en
 * personal-timesheet-workbook.ts voor hoe die cellen precies gevuld worden.
 *
 * Scope/mapping-beslissingen (bevestigd door de klant, 10/9/2026 — zie de
 * AskUserQuestion-uitwisseling in de projectgeschiedenis):
 * - Eén werknemer, het volledige jaar 2026 tegelijk (alle 12 tabbladen).
 *   Enkel jaar 2026 wordt ondersteund — de feestdagenlijst in het
 *   "Basisgegevens"-tabblad van het sjabloon staat hardcoded op 2026; een
 *   volgend jaar vraagt een nieuw sjabloon (of een aparte feestdagenlijst),
 *   bewust niet vooruit gebouwd zolang daar geen concrete vraag voor is.
 * - PROJECT_WORK-registraties vullen Start/Einde (D/E); TRAVEL-registraties
 *   vullen Vertrek/Aankomst (C/F) — enkel op dagen mét een Start/Einde
 *   (anders zou de Reisuren-formule in het sjabloon, die C/D/E/F samen
 *   combineert, een onzinnig resultaat geven op een dag zonder werkuren).
 * - Verlof-/afwezigheidscodes (kolom H: ADV/BF/VAK/ZZW/OPL/...) blijven
 *   altijd blanco — ons systeem houdt geen verlof/ziekte bij, de klant vult
 *   dit zelf manueel aan in Excel.
 * - KM heen/terug (R/S): wij bewaren enkel de enkele-richting-afstand per
 *   werkbon (WorkOrder.kmDistanceOneWayMeters) — dezelfde waarde komt in
 *   zowel "heen" als "terug" te staan (samen dus de al-bevroren
 *   heen-en-terug-afstand van de werkbon).
 *
 * Net als de bestaande uren-export (HoursExportService) worden enkel
 * ONDERTEKENDE werkbonnen meegenomen voor PROJECT_WORK — "een
 * niet-ondertekende werkbon is nog geen definitieve, betrouwbare
 * urenregistratie" (sectie 11). Bewust NIET gefilterd op
 * `hoursExportedAt` (in tegenstelling tot HoursExportService): dit is een
 * persoonlijk naslagdocument, geen facturatie-/loonverwerkingsstap, dus
 * "al gemarkeerd als geëxporteerd" is hier niet van toepassing.
 */

export const PERSONAL_TIMESHEET_YEAR = 2026;

export type TimeEntryActivityTypeForTimesheet = 'PROJECT_WORK' | 'TRAVEL' | 'INTERNAL' | 'TRAINING' | 'OTHER';

/** Ruwe, plat-getrokken invoer voor computeDayRows() — bewust los van Prisma's rijvorm, voor eenvoudig unit-testen. */
export interface TimesheetRawEntry {
  activityType: TimeEntryActivityTypeForTimesheet;
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
  /** Enkel gezet voor PROJECT_WORK-registraties gekoppeld aan een ondertekende werkbon. */
  workOrder: {
    id: string;
    description: string | null;
    kmDistanceOneWayMeters: number | null;
    projectName: string;
    customerName: string;
  } | null;
}

/** Berekende waarden voor precies één kalenderdag-rij in het sjabloon. Elk `*Fraction`-veld is een Excel-tijdfractie (0..1, = seconden/86400) of `null` (cel blijft leeg). */
export interface PersonalTimesheetDayValue {
  month: number; // 0-11
  dayOfMonth: number; // 1-31
  startFraction: number | null;
  endFraction: number | null;
  pauzeFraction: number | null;
  vertrekFraction: number | null;
  aankomstFraction: number | null;
  kmHeen: number | null;
  kmTerug: number | null;
  project: string | null;
  opmerkingen: string | null;
}

function timeOfDayFraction(date: Date): number {
  const secondsSinceMidnight = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  return secondsSinceMidnight / 86400;
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Groepeert een platte lijst tijdregistraties per kalenderdag en berekent
 * per dag de waarden voor de invoerkolommen van het sjabloon. Meerdere
 * PROJECT_WORK-registraties op dezelfde dag (bv. twee verschillende
 * werven): Start = vroegste begin, Einde = laatste einde, en Pauze wordt zo
 * berekend dat de sjabloonformule ((Einde-Start)-Pauze) exact de
 * werkelijk-gewerkte tijd (som van alle registraties, ongepauzeerd)
 * teruggeeft — ook als er tussen de registraties een gat zit (bv. tussen
 * twee werven) dat strikt genomen geen "pauze" was.
 */
export function computeDayRows(entries: TimesheetRawEntry[]): PersonalTimesheetDayValue[] {
  const byDay = new Map<string, { date: Date; entries: TimesheetRawEntry[] }>();
  for (const entry of entries) {
    const key = dayKeyOf(entry.startedAt);
    const existing = byDay.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      byDay.set(key, { date: entry.startedAt, entries: [entry] });
    }
  }

  const rows: PersonalTimesheetDayValue[] = [];
  for (const { date, entries: dayEntries } of byDay.values()) {
    const workEntries = dayEntries.filter((e) => e.activityType === 'PROJECT_WORK' && e.workOrder);
    const travelEntries = dayEntries.filter((e) => e.activityType === 'TRAVEL');

    let startFraction: number | null = null;
    let endFraction: number | null = null;
    let pauzeFraction: number | null = null;
    let vertrekFraction: number | null = null;
    let aankomstFraction: number | null = null;
    let kmHeen: number | null = null;
    let kmTerug: number | null = null;
    let project: string | null = null;
    let opmerkingen: string | null = null;

    if (workEntries.length > 0) {
      const workStart = workEntries.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), workEntries[0]!.startedAt);
      const workEnd = workEntries.reduce((max, e) => (e.endedAt > max ? e.endedAt : max), workEntries[0]!.endedAt);
      const totalWorkedSeconds = workEntries.reduce(
        (sum, e) => sum + Math.max(0, (e.endedAt.getTime() - e.startedAt.getTime()) / 1000 - e.pausedSeconds),
        0,
      );
      const grossSpanSeconds = (workEnd.getTime() - workStart.getTime()) / 1000;
      const pauzeSeconds = Math.max(0, grossSpanSeconds - totalWorkedSeconds);

      startFraction = timeOfDayFraction(workStart);
      endFraction = timeOfDayFraction(workEnd);
      pauzeFraction = pauzeSeconds / 86400;

      // Distinct werkbonnen die dag (kan >1 zijn bij meerdere werven op één dag).
      const workOrdersToday = new Map<string, NonNullable<TimesheetRawEntry['workOrder']>>();
      for (const e of workEntries) {
        if (e.workOrder) workOrdersToday.set(e.workOrder.id, e.workOrder);
      }
      const distinctWorkOrders = Array.from(workOrdersToday.values());

      const projectLabels = Array.from(
        new Set(distinctWorkOrders.map((wo) => `${wo.customerName} - ${wo.projectName}`)),
      );
      project = projectLabels.length > 0 ? projectLabels.join('; ') : null;

      const descriptions = distinctWorkOrders
        .map((wo) => wo.description?.trim())
        .filter((d): d is string => Boolean(d));
      opmerkingen = descriptions.length > 0 ? descriptions.join(' | ') : null;

      const totalKmMeters = distinctWorkOrders.reduce((sum, wo) => sum + (wo.kmDistanceOneWayMeters ?? 0), 0);
      if (totalKmMeters > 0) {
        const km = Math.round((totalKmMeters / 1000) * 100) / 100;
        kmHeen = km;
        kmTerug = km;
      }

      if (travelEntries.length > 0) {
        const sortedTravel = [...travelEntries].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
        const earliestTravel = sortedTravel[0]!;
        const latestTravel = sortedTravel[sortedTravel.length - 1]!;
        // Vertrek/Aankomst omkaderen de werkdag (sjabloonformule M3 = (D3-C3)+(F3-E3))
        // — enkel invullen wanneer dat ook effectief zo ligt, anders blijft de cel leeg
        // i.p.v. een onzinnige (negatieve) Reisuren-berekening te veroorzaken.
        if (earliestTravel.startedAt <= workStart) {
          vertrekFraction = timeOfDayFraction(earliestTravel.startedAt);
        }
        if (latestTravel.endedAt >= workEnd) {
          aankomstFraction = timeOfDayFraction(latestTravel.endedAt);
        }
      }
    }

    rows.push({
      month: date.getMonth(),
      dayOfMonth: date.getDate(),
      startFraction,
      endFraction,
      pauzeFraction,
      vertrekFraction,
      aankomstFraction,
      kmHeen,
      kmTerug,
      project,
      opmerkingen,
    });
  }

  return rows;
}

/** Vorm van de Prisma-rij die buildWorkbookForEmployee() ophaalt — zelfde `as unknown as ...`-patroon als EmployeeWithSignedEntriesRow in hours-export.service.ts (de stale, lokaal niet-regenereerbare Prisma-clientstub typeert findMany() hier onvoldoende specifiek af). */
interface RawTimeEntryRow {
  activityType: string;
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  workOrderLink: {
    workOrder: {
      id: string;
      description: string | null;
      kmDistanceOneWayMeters: number | null;
      signature: { signedAt: Date } | null;
      project: { name: string; customer: { name: string } };
    };
  } | null;
}

export class PersonalTimesheetService {
  constructor(private readonly prisma: PrismaClient) {}

  async buildWorkbookForEmployee(employeeId: string): Promise<{ buffer: Buffer; displayName: string }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, displayName: true },
    });
    if (!employee) {
      throw HoursExportErrors.employeeNotFound();
    }

    const yearStart = new Date(PERSONAL_TIMESHEET_YEAR, 0, 1, 0, 0, 0, 0);
    const yearEnd = new Date(PERSONAL_TIMESHEET_YEAR + 1, 0, 1, 0, 0, 0, 0);

    const rawEntries = (await this.prisma.timeEntry.findMany({
      where: {
        employeeId,
        endedAt: { not: null, gte: yearStart, lt: yearEnd },
      },
      select: {
        activityType: true,
        startedAt: true,
        endedAt: true,
        pausedSeconds: true,
        workOrderLink: {
          select: {
            workOrder: {
              select: {
                id: true,
                description: true,
                kmDistanceOneWayMeters: true,
                signature: { select: { signedAt: true } },
                project: { select: { name: true, customer: { select: { name: true } } } },
              },
            },
          },
        },
      },
    })) as unknown as RawTimeEntryRow[];

    const entries: TimesheetRawEntry[] = rawEntries
      .filter((e) => e.endedAt != null)
      .filter((e) => e.activityType !== 'PROJECT_WORK' || e.workOrderLink?.workOrder.signature?.signedAt != null)
      .map((e) => ({
        activityType: e.activityType as TimeEntryActivityTypeForTimesheet,
        startedAt: e.startedAt,
        endedAt: e.endedAt as Date,
        pausedSeconds: e.pausedSeconds,
        workOrder: e.workOrderLink
          ? {
              id: e.workOrderLink.workOrder.id,
              description: e.workOrderLink.workOrder.description,
              kmDistanceOneWayMeters: e.workOrderLink.workOrder.kmDistanceOneWayMeters,
              projectName: e.workOrderLink.workOrder.project.name,
              customerName: e.workOrderLink.workOrder.project.customer.name,
            }
          : null,
      }));

    const dayRows = computeDayRows(entries);
    const buffer = await fillPersonalTimesheetTemplate(employee.displayName, dayRows);
    return { buffer, displayName: employee.displayName };
  }
}
