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
