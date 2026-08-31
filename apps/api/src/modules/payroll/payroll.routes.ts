import type {
  CreatePayrollBatchBody,
  CreatePayrollBatchResponseBody,
  ListPayableSummaryResponseBody,
  ListPayrollBatchesResponseBody,
  PayrollBatchSummary,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { AuthErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';
import type { PayrollBatchRecord } from './payroll.service';
import { PayrollService } from './payroll.service';
import { createPayrollBatchBodySchema, listPayableSummaryQuerySchema, listPayrollBatchesQuerySchema, payrollBatchIdParamsSchema } from './payroll.schemas';

/**
 * Phase 12, deel E — "Personeelsuitbetaling" (maandoverzicht per medewerker).
 * Bewust ADMIN-only, zelfde rechtenniveau als het Facturatie-overzicht
 * (invoice-batch.routes.ts, sectie 4: "boekhouding") — dit toont bedragen die
 * nooit voor een medewerker zelf zichtbaar mogen zijn (business rule 11).
 */
export default async function payrollRoutes(app: FastifyInstance): Promise<void> {
  const service = new PayrollService(app.prisma);

  app.get(
    '/admin/payroll/payable',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<ListPayableSummaryResponseBody> => {
      const query = listPayableSummaryQuerySchema.parse(request.query);
      const employees = await service.listPayableSummary(query.periodLabel);
      return { employees };
    },
  );

  app.get(
    '/admin/payroll/batches',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<ListPayrollBatchesResponseBody> => {
      const query = listPayrollBatchesQuerySchema.parse(request.query);
      const batches = await service.list(query);
      return { batches: batches.map(toBatchSummary) };
    },
  );

  app.post(
    '/admin/payroll/batches',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply): Promise<CreatePayrollBatchResponseBody> => {
      const body: CreatePayrollBatchBody = createPayrollBatchBodySchema.parse(request.body);
      const userId = request.currentUser?.id;
      if (!userId) {
        throw AuthErrors.notAuthenticated();
      }
      const batch = await service.createBatch(body.employeeId, body.periodLabel, userId);
      reply.code(201);
      return { batch: toBatchSummary(batch) };
    },
  );

  app.post(
    '/admin/payroll/batches/:id/remove',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = payrollBatchIdParamsSchema.parse(request.params);
      await service.remove(params.id);
      reply.code(204);
      return null;
    },
  );
}

function toBatchSummary(batch: PayrollBatchRecord): PayrollBatchSummary {
  return {
    id: batch.id,
    employeeId: batch.employeeId,
    employeeDisplayName: batch.employeeDisplayName,
    periodLabel: batch.periodLabel,
    status: batch.status,
    totalAmountCents: batch.totalAmountCents,
    createdAt: batch.createdAt.toISOString(),
    closedAt: batch.closedAt ? batch.closedAt.toISOString() : null,
    lines: batch.lines,
  };
}
