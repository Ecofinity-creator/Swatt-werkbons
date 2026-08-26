import { z } from 'zod';

export const customerIdParamsSchema = z.object({ id: z.string().uuid() });

/** `null` wist het tarief weer; anders een positief bedrag in eurocent (zie UpdateCustomerHourlyRateBody). */
export const updateCustomerHourlyRateBodySchema = z.object({
  hourlyRateCents: z.number().int().positive().nullable(),
});
