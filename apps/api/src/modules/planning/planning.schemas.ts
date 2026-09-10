import { z } from 'zod';

/**
 * Fase 13 (concept) — planningsmodule. Enkel vorm-validatie hier (zelfde
 * patroon als elders, bv. time-entry.schemas.ts) — de business-controles
 * (medewerker/project bestaat, minstens 1 weekdag, einddatum na startdatum,
 * MVP-lengtegrens) staan bewust in PlanningService zodat een specifieke,
 * mensentaal-foutmelding bij de gebruiker terechtkomt (sectie 27) i.p.v. de
 * generieke "De ingevoerde gegevens zijn niet geldig" van een ZodError.
 */
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Ongeldige datum (verwacht: JJJJ-MM-DD).' });

/** 0=maandag .. 6=zondag. */
const weekdaySchema = z.number().int().min(0).max(6);

export const planningWeekQuerySchema = z.object({
  weekStart: dateOnlySchema,
});

export const planningMineQuerySchema = z.object({
  /** Aantal dagen vooruit (incl. vandaag) — default 14, zie EmployeeProjectsPage.tsx ("Mijn planning"). */
  days: z.coerce.number().int().min(1).max(60).optional().default(14),
});

export const createPlanningAssignmentBodySchema = z.object({
  employeeId: z.string().uuid(),
  projectId: z.string().uuid(),
  date: dateOnlySchema,
});

export const clearPlanningAssignmentBodySchema = z.object({
  employeeId: z.string().uuid(),
  date: dateOnlySchema,
});

export const createPlanningSeriesBodySchema = z.object({
  employeeId: z.string().uuid(),
  projectId: z.string().uuid(),
  weekdays: z.array(weekdaySchema).min(1),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
});

export const planningSeriesIdParamsSchema = z.object({
  id: z.string().uuid(),
});
