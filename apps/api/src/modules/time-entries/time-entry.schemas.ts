import { z } from 'zod';

export const timeEntryIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const startTimeEntryBodySchema = z.object({
  projectId: z.string().uuid(),
});

export type StartTimeEntryBody = z.infer<typeof startTimeEntryBodySchema>;

export const stopTimeEntryBodySchema = z.object({
  description: z.string().trim().min(1).optional(),
});

export type StopTimeEntryBody = z.infer<typeof stopTimeEntryBodySchema>;
