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
