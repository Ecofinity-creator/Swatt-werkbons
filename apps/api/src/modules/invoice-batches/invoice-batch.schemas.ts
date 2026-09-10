import { z } from 'zod';

export const listInvoiceableWorkOrdersQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  periodLabel: z.string().trim().min(1).optional(),
});

export const listInvoiceBatchesQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  periodLabel: z.string().trim().min(1).optional(),
});

export const createInvoiceBatchBodySchema = z.object({
  customerId: z.string().uuid(),
  /** bv. "2026-08" — vrije tekst, zie de toelichting bij InvoiceBatch.periodLabel in schema.prisma. */
  periodLabel: z.string().trim().min(1).max(50),
  workOrderIds: z.array(z.string().uuid()).min(1, 'Selecteer minstens één werkbon om te factureren.'),
});

export const invoiceBatchIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const invoiceBatchProjectRateParamsSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
});

/** `null` wist de eenmalige override weer; anders een positief bedrag in eurocent (zie UpdateInvoiceBatchProjectRateBody). */
export const updateInvoiceBatchProjectRateBodySchema = z.object({
  hourlyRateCents: z.number().int().positive().nullable(),
});

export const invoiceBatchLineParamsSchema = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid(),
});

/**
 * Klantvraag 10/9/2026 — correctie van uren/km per werkbonregel. Elk veld
 * `null` wist die correctie weer (terug naar de werkelijke waarde); anders
 * nul of positief (nooit negatief factureren). `adjustmentNote` is vrije
 * tekst, optioneel.
 */
export const setInvoiceBatchLineAdjustmentBodySchema = z.object({
  adjustedInvoiceableSeconds: z.number().int().min(0).nullable(),
  adjustedKmAmountCents: z.number().int().min(0).nullable(),
  adjustmentNote: z.string().trim().max(500).nullable(),
});

/**
 * Klantvraag 10/9/2026 — "werkbonnen exporteren per klant/per maand of per
 * klant/per week in 1 pdf". Zonder `week` wordt de volledige batch gebundeld
 * (= de hele factuurperiode, altijd een maand — zie InvoiceBatch.periodLabel);
 * met `week` enkel de werkbonnen die in die ISO-8601-week ondertekend werden
 * (zie invoice-batch-pdf-bundle.service.ts's isoWeekKeyOf).
 */
export const workOrderPdfBundleQuerySchema = z.object({
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'Ongeldige weeknotatie, verwacht bv. "2026-W32".')
    .optional(),
});
