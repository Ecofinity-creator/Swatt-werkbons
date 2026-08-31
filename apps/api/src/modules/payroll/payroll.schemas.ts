import { z } from 'zod';

export const listPayableSummaryQuerySchema = z.object({
  periodLabel: z.string().trim().min(1).optional(),
});

export const listPayrollBatchesQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  periodLabel: z.string().trim().min(1).optional(),
});

export const createPayrollBatchBodySchema = z.object({
  employeeId: z.string().uuid(),
  periodLabel: z.string().trim().min(1, 'Kies een periode.'),
});

export const payrollBatchIdParamsSchema = z.object({
  id: z.string().uuid(),
});
