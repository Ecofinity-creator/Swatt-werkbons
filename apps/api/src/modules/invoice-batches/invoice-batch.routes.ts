import type {
  CreateInvoiceBatchBody,
  CreateInvoiceBatchResponseBody,
  InvoiceBatchSummary,
  InvoiceableWorkOrderSummary,
  ListInvoiceBatchesResponseBody,
  ListInvoiceableWorkOrdersResponseBody,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { AuthErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';
import type { InvoiceBatchRecord, InvoiceableWorkOrderRecord } from './invoice-batch.service';
import { InvoiceBatchService } from './invoice-batch.service';
import {
  createInvoiceBatchBodySchema,
  invoiceBatchIdParamsSchema,
  listInvoiceBatchesQuerySchema,
  listInvoiceableWorkOrdersQuerySchema,
} from './invoice-batch.schemas';

/**
 * Phase 10 — facturatie-overzicht (sectie 17/29). ADMIN-only: sectie 4 noemt
 * "factureerbare prestaties controleren", "facturatieperiode afsluiten" en
 * "facturen voorbereiden" expliciet bij de Administrator-rol, niet bij
 * Supervisor.
 */
export default async function invoiceBatchRoutes(app: FastifyInstance): Promise<void> {
  const service = new InvoiceBatchService(app.prisma);

  app.get(
    '/admin/invoice-batches/invoiceable-work-orders',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<ListInvoiceableWorkOrdersResponseBody> => {
      const query = listInvoiceableWorkOrdersQuerySchema.parse(request.query);
      const workOrders = await service.listInvoiceable(query);
      return { workOrders: workOrders.map(toInvoiceableSummary) };
    },
  );

  app.get(
    '/admin/invoice-batches',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<ListInvoiceBatchesResponseBody> => {
      const query = listInvoiceBatchesQuerySchema.parse(request.query);
      const batches = await service.list(query);
      return { batches: batches.map(toBatchSummary) };
    },
  );

  app.post(
    '/admin/invoice-batches',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply): Promise<CreateInvoiceBatchResponseBody> => {
      const body: CreateInvoiceBatchBody = createInvoiceBatchBodySchema.parse(request.body);
      const userId = request.currentUser?.id;
      if (!userId) {
        throw AuthErrors.notAuthenticated();
      }
      const batch = await service.create({ ...body, createdByUserId: userId });
      reply.code(201);
      return { batch: toBatchSummary(batch) };
    },
  );

  app.post(
    '/admin/invoice-batches/:id/remove',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = invoiceBatchIdParamsSchema.parse(request.params);
      await service.remove(params.id);
      reply.code(204);
      return null;
    },
  );
}

function toInvoiceableSummary(record: InvoiceableWorkOrderRecord): InvoiceableWorkOrderSummary {
  return {
    id: record.id,
    workOrderNumber: record.workOrderNumber,
    signedAt: record.signedAt?.toISOString() ?? null,
    invoiceableSeconds: record.invoiceableSeconds,
    customer: record.customer,
    project: record.project,
    employeeDisplayNames: record.employeeDisplayNames,
  };
}

function toBatchSummary(batch: InvoiceBatchRecord): InvoiceBatchSummary {
  return {
    id: batch.id,
    customerId: batch.customerId,
    customerName: batch.customer.name,
    periodLabel: batch.periodLabel,
    status: batch.status,
    totalInvoiceableSeconds: batch.totalInvoiceableSeconds,
    createdAt: batch.createdAt.toISOString(),
    lines: batch.lines.map((line) => ({
      id: line.id,
      workOrderId: line.workOrderId,
      workOrderNumber: line.workOrder.workOrderNumber,
      projectName: line.workOrder.project.name,
      invoiceableSeconds: line.invoiceableSeconds,
    })),
  };
}
