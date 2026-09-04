import { z } from 'zod';

export const timeEntryIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const startTimeEntryBodySchema = z.object({
  projectId: z.string().uuid(),
});

export type StartTimeEntryBody = z.infer<typeof startTimeEntryBodySchema>;

/**
 * Op vraag (4/9/2026, Belgische verplichte urenregistratie vanaf 1/1/2027) —
 * zie TimeEntryService.startGeneral(). Vrije omschrijving optioneel (bv. "Rit
 * naar werf Janssens BV"), niet verplicht — de activityType zelf is al
 * betekenisvol genoeg voor een objectieve registratie.
 */
export const startGeneralTimeEntryBodySchema = z.object({
  activityType: z.enum(['TRAVEL', 'INTERNAL', 'TRAINING', 'OTHER']),
  description: z.string().trim().min(1).optional(),
});

export type StartGeneralTimeEntryBody = z.infer<typeof startGeneralTimeEntryBodySchema>;

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
 *
 * Enkel vorm-validatie hier — de business-controles (eindtijd na starttijd,
 * geen toekomstige tijdstippen, pauze niet langer dan de periode) staan
 * bewust in TimeEntryService.createManual() i.p.v. als zod `.refine()`: elke
 * ZodError wordt door de globale errorhandler (sectie 27) herleid tot de
 * generieke "De ingevoerde gegevens zijn niet geldig" — via een ApiError uit
 * de service komt de specifieke, mensentaal-foutmelding wél bij de
 * werknemer terecht (zie TimeEntryErrors.manual* in errors.ts).
 */
export const createManualTimeEntryBodySchema = z.object({
  projectId: z.string().uuid(),
  startedAt: z.string().datetime({ message: 'Ongeldig starttijdstip.' }),
  endedAt: z.string().datetime({ message: 'Ongeldig eindtijdstip.' }),
  pausedMinutes: z.number().int().min(0).max(24 * 60).optional().default(0),
  description: z.string().trim().min(1).optional(),
});

export type CreateManualTimeEntryBody = z.infer<typeof createManualTimeEntryBodySchema>;

/**
 * Sectie 4: SUPERVISOR+ corrigeert een STOPPED registratie —
 * POST /time-entries/:id/correct. Enkel toegestaan zolang de gekoppelde
 * werkbon nog DRAFT/READY_FOR_SIGNATURE is; TimeEntryService.correct()
 * weigert daarna met TIME_ENTRY_CORRECTION_BLOCKED_SIGNED.
 */
export const correctTimeEntryBodySchema = z.object({
  startedAt: z.string().datetime({ message: 'Ongeldig starttijdstip.' }),
  endedAt: z.string().datetime({ message: 'Ongeldig eindtijdstip.' }),
  pausedMinutes: z.number().int().min(0).max(24 * 60).optional().default(0),
  description: z.string().trim().min(1).optional(),
});

export type CorrectTimeEntryBody = z.infer<typeof correctTimeEntryBodySchema>;
