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
 * Phase 12, deel A (sectie 1): overuren staat onafhankelijk naast
 * ploegenwerk/nachtwerk (die elkaar uitsluiten via premiumType, radiovakjes
 * in de UI — zie ProjectAssignment.premiumType in schema.prisma).
 */
export const updateProjectAssignmentPremiumsBodySchema = z.object({
  projectId: z.string().uuid(),
  overtimeApplies: z.boolean(),
  premiumType: z.enum(['NONE', 'SHIFT_WORK', 'NIGHT_WORK']),
});

/**
 * Phase 12, deel A: "Overuren boven 8u/dag" (DAILY, geen invoerveld nodig) of
 * "Overuren boven [x]u/week" (WEEKLY, drempel verplicht). `superRefine`
 * dwingt af dat de drempel effectief ingevuld is bij WEEKLY — een lege
 * drempel zou stilzwijgend terugvallen op de default (39) in
 * rate-calculation.service.ts, wat verwarrend zou zijn op het scherm zelf.
 */
export const updateProjectOvertimeSettingsBodySchema = z
  .object({
    overtimeThresholdType: z.enum(['DAILY', 'WEEKLY']),
    overtimeWeeklyThresholdHours: z.number().positive().max(80).nullable().optional(),
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
