/**
 * Phase 12, deel A (sectie 1 van de projectbrief) — "overuren-, ploegenwerk-
 * en nachtwerktoeslag". Bewust een losse, puur-functionele module (geen
 * Prisma-afhankelijkheid, geen class-state) zodat dit zonder database
 * unit-testbaar is — zelfde patroon als rbac.middleware.ts.
 *
 * Fase 12-herziening: de volledige toeslagregeling (drempel, of overuren van
 * toepassing is, welke premium, en de percentages zelf) zit sinds deze
 * herziening uniform op `Project` — niet meer verspreid over
 * Employee/ProjectAssignment. Reden: "de medewerker/onderaannemer wordt
 * uitbetaald volgens de afspraken met de klant", dus dit is een
 * project-/klantafspraak, geen persoonlijke instelling. Elke medewerker die
 * op een project werkt, valt automatisch onder dezelfde regeling.
 *
 * Twee onafhankelijke berekeningen:
 * 1. `splitEffectiveHours()` — hoeveel van een blok gewerkte uren (al
 *    samengeteld per dag of per week, naargelang Project.overtimeThresholdType)
 *    normale uren zijn, en hoeveel overuren.
 * 2. `computeRatePercent()` — welk percentage van het basistarief van
 *    toepassing is op resp. de normale uren en de overuren van een project
 *    (toeslagen tellen op boven 100%, ze worden nooit vermenigvuldigd — zie
 *    de toelichting in het ontwerpdocument). Dit percentage wordt door de
 *    aanroeper toegepast op zowel `Employee.defaultHourlyRateCents`
 *    (facturatie aan de klant) als `Employee.payrollRateCents` (uitbetaling)
 *    — zelfde percentage, andere basis.
 *
 * Belangrijk: ploegenwerk/nachtwerk geldt op ALLE uren van een project (het
 * is geen overurendrempel-gebonden toeslag), overuren enkel op het deel
 * boven de drempel. Vandaar twee aparte percentages in het resultaat.
 */

const DAILY_THRESHOLD_HOURS = 8;

/** Alle toeslaginstellingen van één project — samen gebruikt door beide berekeningen hieronder. */
export interface ProjectPremiumSettings {
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  /** Enkel relevant/ingevuld bij WEEKLY — vrij instelbaar getal (bv. 39 of 40). */
  overtimeWeeklyThresholdHours: number | null;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
}

export interface EffectiveHoursSplit {
  normalHours: number;
  overtimeHours: number;
}

export interface RatePercentSplit {
  /** Percentage van het basistarief op de normale uren (100 + evt. ploegen-/nachttoeslag). */
  normalPercent: number;
  /** Percentage van het basistarief op de overuren (normalPercent + evt. overurentoeslag). */
  overtimePercent: number;
}

/**
 * Verdeelt de overuren-splitsing van een volledige periode-bucket (dag of
 * week) terug over de individuele bronregistraties waaruit die bucket is
 * opgebouwd — nodig voor Phase 12, deel E (personeelsuitbetaling), waar elke
 * regel op precies één brontijdregistratie moet herleidbaar zijn (business
 * rule 12), in tegenstelling tot de klantfactuur (deel A) die enkel een
 * totaal per medewerker/project nodig heeft.
 *
 * Vult de normale-urencapaciteit chronologisch op: de eerste registraties van
 * de dag/week tellen als normaal totdat de drempel bereikt is, alles daarna
 * (en het deel van de registratie die net over de drempel heen valt) telt als
 * overuren. `entries` moet al chronologisch gesorteerd zijn (oudste eerst) —
 * deze functie sorteert zelf niet, om geen aannames te doen over hoe de
 * aanroeper `startedAt` precies vergelijkt (tijdzones, gelijke tijdstippen).
 */
export function allocateHoursAcrossEntries(
  entries: Array<{ id: string; hours: number }>,
  project: Pick<ProjectPremiumSettings, 'overtimeThresholdType' | 'overtimeWeeklyThresholdHours'>,
): Map<string, EffectiveHoursSplit> {
  const threshold =
    project.overtimeThresholdType === 'DAILY' ? DAILY_THRESHOLD_HOURS : (project.overtimeWeeklyThresholdHours ?? 39);

  const result = new Map<string, EffectiveHoursSplit>();
  let cumulativeBefore = 0;
  for (const entry of entries) {
    const remainingNormalCapacity = Math.max(0, threshold - cumulativeBefore);
    const normalHours = Math.min(entry.hours, remainingNormalCapacity);
    const overtimeHours = entry.hours - normalHours;
    result.set(entry.id, { normalHours, overtimeHours });
    cumulativeBefore += entry.hours;
  }
  return result;
}

/**
 * Splitst een reeds samengeteld urenblok (één dag bij DAILY, één kalenderweek
 * bij WEEKLY — de aanroeper telt dit vooraf op, deze functie kent geen datums)
 * in normale uren en overuren op basis van de projectdrempel. Geeft altijd
 * `{ normalHours: totalHours, overtimeHours: 0 }` terug wanneer overuren niet
 * van toepassing is op het project — de aanroeper roept deze functie dus
 * enkel aan wanneer `project.overtimeApplies === true`.
 */
export function splitEffectiveHours(
  totalHours: number,
  project: Pick<ProjectPremiumSettings, 'overtimeThresholdType' | 'overtimeWeeklyThresholdHours'>,
): EffectiveHoursSplit {
  const threshold =
    project.overtimeThresholdType === 'DAILY' ? DAILY_THRESHOLD_HOURS : (project.overtimeWeeklyThresholdHours ?? 39);

  if (totalHours <= threshold) {
    return { normalHours: totalHours, overtimeHours: 0 };
  }
  return { normalHours: threshold, overtimeHours: totalHours - threshold };
}

/**
 * Toeslagpercentages tellen op boven de 100% basis, nooit vermenigvuldigd —
 * bv. overuren (150% = +50%) + nachtwerk (150% = +50%) → 200%; overuren
 * (150% = +50%) + ploegenwerk (120% = +20%) → 170%. Ploegenwerk/nachtwerk telt
 * mee op zowel de normale uren als de overuren van dit project (het is een
 * "hoe/wanneer werd er gewerkt"-toeslag, geen overurendrempel-toeslag).
 */
export function computeRatePercent(
  project: Pick<ProjectPremiumSettings, 'overtimeApplies' | 'premiumType' | 'overtimeRatePercent' | 'shiftWorkRatePercent' | 'nightWorkRatePercent'>,
): RatePercentSplit {
  const premiumSurcharge =
    project.premiumType === 'SHIFT_WORK'
      ? project.shiftWorkRatePercent - 100
      : project.premiumType === 'NIGHT_WORK'
        ? project.nightWorkRatePercent - 100
        : 0;

  const normalPercent = 100 + premiumSurcharge;
  const overtimeSurcharge = project.overtimeApplies ? project.overtimeRatePercent - 100 : 0;
  const overtimePercent = normalPercent + overtimeSurcharge;

  return { normalPercent, overtimePercent };
}
