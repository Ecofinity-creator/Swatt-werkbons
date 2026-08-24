import { z } from 'zod';

export const workOrderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createWorkOrderBodySchema = z.object({
  projectId: z.string().uuid(),
  timeEntryIds: z.array(z.string().uuid()).min(1),
  description: z.string().trim().min(1).optional(),
});

export type CreateWorkOrderBody = z.infer<typeof createWorkOrderBodySchema>;
