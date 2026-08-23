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
