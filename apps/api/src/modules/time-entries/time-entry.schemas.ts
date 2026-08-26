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

/**
 * Sectie 6: "manueel tijd toevoegen indien toegestaan" — POST /time-entries/manual.
 * `startedAt`/`endedAt` zijn volledige ISO-tijdstippen (de frontend zet
 * datum + uur/minuut zelf om naar UTC vóór verzending, zie ProjectTimerPage.tsx).
 * `pausedMinutes` is optioneel (standaard 0) en wordt in de service naar
 * seconden omgezet, consistent met `TimeEntry.pausedSeconds`.
 */
export const createManualTimeEntryBodySchema = z
  .object({
    projectId: z.string().uuid(),
    startedAt: z.string().datetime({ message: 'Ongeldig starttijdstip.' }),
    endedAt: z.string().datetime({ message: 'Ongeldig eindtijdstip.' }),
    pausedMinutes: z.number().int().min(0).max(24 * 60).optional().default(0),
    description: z.string().trim().min(1).optional(),
  })
  .refine((data) => new Date(data.endedAt).getTime() > new Date(data.startedAt).getTime(), {
    message: 'Eindtijd moet na de starttijd liggen.',
    path: ['endedAt'],
  })
  .refine((data) => new Date(data.startedAt).getTime() <= Date.now(), {
    message: 'Starttijd kan niet in de toekomst liggen.',
    path: ['startedAt'],
  })
  .refine((data) => new Date(data.endedAt).getTime() <= Date.now(), {
    message: 'Eindtijd kan niet in de toekomst liggen.',
    path: ['endedAt'],
  })
  .refine(
    (data) => {
      const totalMinutes = (new Date(data.endedAt).getTime() - new Date(data.startedAt).getTime()) / 60000;
      return totalMinutes - (data.pausedMinutes ?? 0) > 0;
    },
    { message: 'De pauze kan niet even lang of langer zijn dan de volledige periode.', path: ['pausedMinutes'] },
  );

export type CreateManualTimeEntryBody = z.infer<typeof createManualTimeEntryBodySchema>;
