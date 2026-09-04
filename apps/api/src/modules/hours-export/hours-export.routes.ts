import type { HoursExportOverviewResponseBody, MarkHoursExportedResponseBody } from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { requireRole } from '../rbac/rbac.middleware';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import { buildEmployeeHoursWorkbook } from './employee-hours-workbook';
import { hoursExportEmployeeParamsSchema, hoursExportPeriodQuerySchema, markHoursExportedBodySchema } from './hours-export.schemas';
import { HoursExportService } from './hours-export.service';
import { buildSubcontractorHoursWorkbook } from './subcontractor-hours-workbook';
import { renderSubcontractorStatementPdf } from './subcontractor-statement-document';

/**
 * Werknemer vs. Onderaannemer — maandelijkse uren-export (backlog-item 30/8,
 * zie claude/projectoverdracht-samenvatting_2.md sectie 3.3). ADMIN-only —
 * zelfde reden als facturatie (sectie 4: "facturen voorbereiden" en
 * "rapporteren" horen bij Administrator, niet Supervisor), en dit betreft
 * net als facturatie gevoelige loon-/betalingsdata.
 */
export default async function hoursExportRoutes(app: FastifyInstance): Promise<void> {
  const service = new HoursExportService(app.prisma);
  const auditLogService = new AuditLogService(app.prisma);
  const storage: StorageService = new DatabaseStorageService(app.prisma);
  const companySettings = new CompanySettingsService(app.prisma);

  app.get(
    '/admin/hours-export/overview',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<HoursExportOverviewResponseBody> => {
      const query = hoursExportPeriodQuerySchema.parse(request.query);
      const employees = await service.listOverview(query.period);
      return { periodLabel: query.period, employees };
    },
  );

  /**
   * Op vraag (3/9/2026): "eens de export is gebeurd zou ervoor gezorgd moeten
   * worden dat die werkbonnen als geëxporteerd gemarkeerd staan... om dubbele
   * facturatie tegen te gaan" — zie HoursExportService.markExported(). Werkt
   * voor zowel EMPLOYEE als SUBCONTRACTOR (de service maakt geen onderscheid,
   * enkel het downloadformaat verschilt tussen beide).
   */
  app.post(
    '/admin/hours-export/mark-exported',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<MarkHoursExportedResponseBody> => {
      const body = markHoursExportedBodySchema.parse(request.body);
      const markedCount = await service.markExported(body.employeeId, body.period);
      await auditLogService.record({
        actorUserId: request.currentUser?.id ?? null,
        action: 'HOURS_EXPORT_MARKED_EXPORTED',
        entityType: 'Employee',
        entityId: body.employeeId,
        metadata: { period: body.period, markedCount },
      });
      return { markedCount };
    },
  );

  // Gedeelde Excel-urenexport voor alle EMPLOYEE-type medewerkers deze periode
  // (ruwe urenlijst, bedoeld voor eigen loonverwerking — zie
  // employee-hours-workbook.ts). Combinée i.p.v. per medewerker: dit is één
  // maandelijkse loonverwerkingsstap, geen document dat naar een derde gaat.
  app.get(
    '/admin/hours-export/employees/excel',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const query = hoursExportPeriodQuerySchema.parse(request.query);
      const employees = await service.listEntriesForEmployees(query.period);
      const buffer = await buildEmployeeHoursWorkbook(query.period, employees);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="urenexport-${query.period}.xlsx"`);
      return reply.send(buffer);
    },
  );

  // Eén totalisatie-met-detail-PDF per onderaannemer (bedoeld om naar die
  // onderaannemer te sturen — zie subcontractor-statement-document.ts).
  app.get(
    '/admin/hours-export/subcontractors/:employeeId/pdf',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = hoursExportEmployeeParamsSchema.parse(request.params);
      const query = hoursExportPeriodQuerySchema.parse(request.query);
      const detail = await service.getSubcontractorDetail(params.employeeId, query.period);

      const company = await companySettings.get();
      const logo = company.logoFileKey ? await storage.read(company.logoFileKey) : null;

      const buffer = await renderSubcontractorStatementPdf({
        displayName: detail.displayName,
        periodLabel: detail.periodLabel,
        totalSeconds: detail.totalSeconds,
        projects: detail.projects,
        company: {
          companyName: company.companyName,
          addressLine: company.addressLine,
          vatNumber: company.vatNumber,
          contactEmail: company.contactEmail,
          contactPhone: company.contactPhone,
          logo,
        },
      });

      reply.header('Content-Type', 'application/pdf');
      reply.header(
        'Content-Disposition',
        `attachment; filename="urenoverzicht-${slugify(detail.displayName)}-${query.period}.pdf"`,
      );
      return reply.send(buffer);
    },
  );

  // Zelfde totalisatie-met-detail als hierboven, nu als Excel-bestand i.p.v.
  // PDF — op uitdrukkelijke vraag naast de bestaande PDF-optie (die blijft
  // gewoon bestaan), zie subcontractor-hours-workbook.ts.
  app.get(
    '/admin/hours-export/subcontractors/:employeeId/excel',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const params = hoursExportEmployeeParamsSchema.parse(request.params);
      const query = hoursExportPeriodQuerySchema.parse(request.query);
      const detail = await service.getSubcontractorDetail(params.employeeId, query.period);

      const buffer = await buildSubcontractorHoursWorkbook(detail);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="urenoverzicht-${slugify(detail.displayName)}-${query.period}.xlsx"`);
      return reply.send(buffer);
    },
  );
}

/** Zelfde aanpak als slugify() in work-order-pdf.service.ts. */
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accenten weg (bv. é → e)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
