import type {
  CreatePayrollBatchBody,
  CreatePayrollBatchResponseBody,
  ListPayableSummaryResponseBody,
  ListPayrollBatchesResponseBody,
  PayrollBatchSummary,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { AuthErrors } from '../../errors';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { requireRole } from '../rbac/rbac.middleware';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import { renderPayrollStatementPdf } from './payroll-statement-document';
import { buildPayrollStatementWorkbook } from './payroll-statement-workbook';
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
  const companySettings = new CompanySettingsService(app.prisma);
  const storage: StorageService = new DatabaseStorageService(app.prisma);

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

  // Downloadbaar overzichtsdocument (PDF) — op vraag, 1/9/2026: "mooie tabel
  // met per dag beginuur, einduur, pauze en totaal gewerkte uren + overuren".
  // Gebaseerd op de al bevroren batch-data, geen verse herberekening.
  app.get(
    '/admin/payroll/batches/:id/pdf',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = payrollBatchIdParamsSchema.parse(request.params);
      const batch = await service.getById(params.id);

      const settings = await companySettings.get();
      const logo = settings.logoFileKey ? await storage.read(settings.logoFileKey) : null;

      const buffer = await renderPayrollStatementPdf(batch, {
        companyName: settings.companyName,
        addressLine: settings.addressLine,
        vatNumber: settings.vatNumber,
        contactEmail: settings.contactEmail,
        contactPhone: settings.contactPhone,
        logo,
      });

      reply.header('Content-Type', 'application/pdf');
      reply.header(
        'Content-Disposition',
        `attachment; filename="personeelsuitbetaling-${slugify(batch.employeeDisplayName)}-${batch.periodLabel}.pdf"`,
      );
      return reply.send(buffer);
    },
  );

  // Zelfde totalisatie-met-detail als hierboven, als Excel-bestand.
  app.get(
    '/admin/payroll/batches/:id/excel',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = payrollBatchIdParamsSchema.parse(request.params);
      const batch = await service.getById(params.id);

      const buffer = await buildPayrollStatementWorkbook(batch);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header(
        'Content-Disposition',
        `attachment; filename="personeelsuitbetaling-${slugify(batch.employeeDisplayName)}-${batch.periodLabel}.xlsx"`,
      );
      return reply.send(buffer);
    },
  );
}

/** Zelfde aanpak als slugify() in work-order-pdf.service.ts/hours-export.routes.ts. */
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accenten weg (bv. é → e)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
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
