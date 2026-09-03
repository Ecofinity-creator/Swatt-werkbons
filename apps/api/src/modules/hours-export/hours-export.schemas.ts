import { z } from 'zod';

/** "2026-08" — zelfde notatie als InvoiceBatch.periodLabel. Verdere validatie (bestaat de maand) gebeurt in HoursExportService.assertValidPeriod. */
export const hoursExportPeriodQuerySchema = z.object({
  period: z.string().trim().min(1, 'Periode is verplicht (bv. 2026-08).'),
});

export const hoursExportEmployeeParamsSchema = z.object({
  employeeId: z.string().uuid(),
});

/** Op vraag (3/9/2026) — zie HoursExportService.markExported(). */
export const markHoursExportedBodySchema = z.object({
  employeeId: z.string().uuid(),
  period: z.string().trim().min(1, 'Periode is verplicht (bv. 2026-08).'),
});
