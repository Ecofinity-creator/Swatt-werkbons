import { z } from 'zod';

export const listProjectsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
});

export const employeeIdParamsSchema = z.object({
  employeeId: z.string().uuid(),
});

export const projectAssignmentBodySchema = z.object({
  projectId: z.string().uuid(),
});

export const projectIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Phase 9 — `null` heft de koppeling op (project valt terug op automatische aanmaak bij de volgende sync). */
export const selectProjectMilestoneBodySchema = z.object({
  milestoneId: z.string().uuid().nullable(),
});

/** Phase 12, deel C — sectie 3: facturatie uitschakelen per project (nacalculatie). */
export const updateProjectInvoicingEnabledBodySchema = z.object({
  invoicingEnabled: z.boolean(),
});

/**
 * Fase 12-herziening: overurendrempel + volledige toeslagregeling per
 * project — "Overuren boven 8u/dag" (DAILY, geen invoerveld nodig) of
 * "Overuren boven [x]u/week" (WEEKLY, drempel verplicht), plus of overuren
 * van toepassing is, welke premium (ploegenwerk/nachtwerk sluiten elkaar uit
 * via premiumType, radiovakjes in de UI), en de drie percentages zelf.
 * `superRefine` dwingt af dat de weekdrempel effectief ingevuld is bij
 * WEEKLY — een lege drempel zou stilzwijgend terugvallen op de default (39)
 * in rate-calculation.service.ts, wat verwarrend zou zijn op het scherm zelf.
 */
export const updateProjectOvertimeSettingsBodySchema = z
  .object({
    overtimeThresholdType: z.enum(['DAILY', 'WEEKLY']),
    overtimeWeeklyThresholdHours: z.number().positive().max(80).nullable().optional(),
    overtimeApplies: z.boolean(),
    premiumType: z.enum(['NONE', 'SHIFT_WORK', 'NIGHT_WORK']),
    overtimeRatePercent: z.number().int().min(100).max(500),
    shiftWorkRatePercent: z.number().int().min(100).max(500),
    nightWorkRatePercent: z.number().int().min(100).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.overtimeThresholdType === 'WEEKLY' && (value.overtimeWeeklyThresholdHours === undefined || value.overtimeWeeklyThresholdHours === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overtimeWeeklyThresholdHours'],
        message: 'Vul het aantal uren per week in.',
      });
    }
  });

/** Phase 12, deel B (sectie 2) — "Ondertekening per werkbon" of "Ondertekening per week". */
export const updateProjectSigningModeBodySchema = z.object({
  signingMode: z.enum(['PER_WORK_ORDER', 'WEEKLY']),
});
