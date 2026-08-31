import type { PendingWeekResponseBody, SignWeekResponseBody, WeeklyApprovalSummary } from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors } from '../../errors';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { requireRole } from '../rbac/rbac.middleware';
import { WorkOrderPdfService } from './work-order-pdf.service';
import { WorkOrderService } from './work-order.service';
import { WeeklyApprovalService, type WeeklyApprovalRecord } from './weekly-approval.service';
import { pendingWeekQuerySchema, projectIdParamsSchema, signWeekBodySchema, weeklyApprovalIdParamsSchema } from './weekly-approval.schemas';

const SIGN_BODY_LIMIT = 5 * 1024 * 1024;

/**
 * Phase 12, deel B (sectie 2) — "werkbonnen per week laten tekenen door de
 * klant". Na een geslaagde week-ondertekening doorloopt elke betrokken
 * werkbon zijn EIGEN bestaande PDF-generatie + Teamleader-sync-inplanning
 * (Phase 8/9), exact zoals bij een individuele `/work-orders/:id/sign` — zie
 * de toelichting bij het `WeeklyApproval`-model in schema.prisma voor waarom
 * er bewust geen aparte weekoverzicht-PDF-pijplijn is.
 */
export default async function weeklyApprovalRoutes(app: FastifyInstance): Promise<void> {
  const storage: StorageService = new DatabaseStorageService(app.prisma);
  const workOrderService = new WorkOrderService(app.prisma);
  const companySettingsService = new CompanySettingsService(app.prisma);
  const pdfService = new WorkOrderPdfService(app.prisma, storage, workOrderService, companySettingsService);
  const service = new WeeklyApprovalService(app.prisma, storage, companySettingsService);

  app.get(
    '/work-orders/pending-week',
    { preHandler: [app.authenticate] },
    async (request): Promise<PendingWeekResponseBody> => {
      const employeeId = requireEmployeeId(request);
      const query = pendingWeekQuerySchema.parse(request.query);
      const { weekStartDate, weekEndDate, workOrderIds } = await service.listPendingForEmployee(employeeId, query.projectId);
      return { weekStartDate: weekStartDate.toISOString(), weekEndDate: weekEndDate.toISOString(), workOrderIds };
    },
  );

  app.post(
    '/weekly-approvals/:projectId/sign',
    { preHandler: [app.authenticate], bodyLimit: SIGN_BODY_LIMIT },
    async (request, reply): Promise<SignWeekResponseBody> => {
      // Enkel gebruikt om te garanderen dat de aanvrager een medewerker is —
      // de week zelf bundelt bewust alle collega's (sectie 2), dus geen
      // participant-filter zoals bij een losse werkbon-ondertekening.
      requireEmployeeId(request);
      const params = projectIdParamsSchema.parse(request.params);
      const body = signWeekBodySchema.parse(request.body);
      const userId = request.currentUser?.id;
      if (!userId) {
        throw AuthErrors.notAuthenticated();
      }

      const weeklyApproval = await service.signCurrentWeek(params.projectId, {
        signerName: body.signerName,
        signerFunction: body.signerFunction ?? null,
        requestedByUserId: userId,
        ipAddress: request.ip ?? null,
        image: { data: Buffer.from(body.signatureDataBase64, 'base64'), mimeType: body.mimeType },
      });

      // Zelfde volgorde/redenering als bij een individuele /work-orders/:id/sign
      // (zie work-order.routes.ts): PDF-generatie gebeurt best-effort en
      // gooit zelf nooit verder (WorkOrderPdfService.generate()), Teamleader-
      // sync gaat asynchroon via de queue. Eén mislukte werkbon in de lus mag
      // de andere werkbonnen van de week niet blokkeren — de handtekening
      // zelf staat al onomkeerbaar vast op dit punt.
      for (const workOrderId of weeklyApproval.workOrderIds) {
        try {
          await pdfService.generate(workOrderId);
          await app.syncJobService.enqueueForWorkOrder(workOrderId);
        } catch (err) {
          request.log.error({ err, workOrderId }, 'PDF/sync na weekondertekening mislukt voor deze werkbon');
        }
      }

      reply.code(201);
      return { weeklyApproval: toSummary(weeklyApproval) };
    },
  );

  /**
   * Heropenen — SUPERVISOR+ (sectie 4: "werkbon heropenen" staat daar expliciet
   * bij Supervisor, niet enkel Admin).
   */
  app.post(
    '/admin/weekly-approvals/:id/reopen',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request) => {
      const params = weeklyApprovalIdParamsSchema.parse(request.params);
      await service.reopen(params.id);
      return { success: true };
    },
  );
}

function toSummary(record: WeeklyApprovalRecord): WeeklyApprovalSummary {
  return {
    id: record.id,
    projectId: record.projectId,
    weekStartDate: record.weekStartDate.toISOString(),
    weekEndDate: record.weekEndDate.toISOString(),
    status: record.status,
    signerName: record.signerName,
    signerFunction: record.signerFunction,
    confirmedAt: record.confirmedAt ? record.confirmedAt.toISOString() : null,
    workOrderIds: record.workOrderIds,
  };
}

/** Zelfde helper als work-order.routes.ts — bewust lokaal gedupliceerd (klein, geen gedeelde module voor deze twee regels). */
function requireEmployeeId(request: FastifyRequest): string {
  const employeeId = request.currentUser?.employee?.id;
  if (!employeeId) {
    throw AuthErrors.notAuthenticated();
  }
  return employeeId;
}
