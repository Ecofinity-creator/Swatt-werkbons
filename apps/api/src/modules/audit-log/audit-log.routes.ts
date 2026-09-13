import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AUDIT_LOG_ACTION_LABELS, type AuditLogEntrySummary, type ListAuditLogResponseBody } from '@swatt/shared-types';
import { requireRole } from '../rbac/rbac.middleware';
import { buildAuditLogWorkbook } from './audit-log-workbook';
import { AuditLogService, type AuditLogRecord } from './audit-log.service';

/**
 * Structurele filters, gedeeld tussen het scherm (`GET /admin/audit-log`,
 * met `before`-cursor voor "Meer laden") en de Excel-export hieronder
 * (zonder `before` — die exporteert steeds de volledige, chronologische
 * set voor de gekozen filters, niet enkel de al-geladen pagina).
 */
const auditLogFilterQuerySchema = z.object({
  entityType: z.string().trim().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  /** Vrije code (zie AUDIT_LOG_ACTION_LABELS) — geen enum-validatie, zelfde reden als op `AuditLog.action` zelf. */
  action: z.string().trim().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const listAuditLogQuerySchema = auditLogFilterQuerySchema.extend({
  /** Cursor voor "Meer laden" op AuditLogPage.tsx — enkel rijen strikt vóór dit tijdstip. */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Ruime bovengrens i.p.v. ongelimiteerd — een export blijft in-memory (zelfde patroon als de uren-export-workbooks), maar mag wél de volledige historiek beslaan i.p.v. het scherm se page-grootte. */
const EXPORT_LIMIT = 20000;

/**
 * Op vraag (3/9/2026, uitgebreid 13/9/2026): "auditlog-scherm, om bij een
 * geschil te zien wie iets wanneer gewijzigd heeft" — sectie 23/26 uit de
 * oorspronkelijke projectbrief. Klantvraag 13/9/2026: "een doorzoekbare
 * auditlog-UI... sterk richting bedrijven die met aanbestedingen of
 * verzekeringsvereisten werken" — vandaar ook het Excel-exportendpoint
 * hieronder, naast de filters op het scherm zelf.
 *
 * ADMIN-only: dit toont wie welke financiële/status-wijziging deed, over alle
 * medewerkers heen — zelfde gevoeligheidsniveau als Facturatie/Uren-export.
 */
export default async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  const service = new AuditLogService(app.prisma);

  app.get(
    '/admin/audit-log',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<ListAuditLogResponseBody> => {
      const query = listAuditLogQuerySchema.parse(request.query);
      const entries = await service.list({
        entityType: query.entityType,
        actorUserId: query.actorUserId,
        action: query.action,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        before: query.before ? new Date(query.before) : undefined,
        limit: query.limit,
      });
      return { entries: entries.map(toSummary) };
    },
  );

  /**
   * Excel-export voor aanbestedingen/verzekeraars — dezelfde structurele
   * filters als het scherm (Type/Actie/Door/periode), maar altijd
   * chronologisch (oud → nieuw) en zonder de `before`-paginering: dit is
   * bedoeld als één volledig, dateerbaar bewijsstuk voor de gekozen
   * periode/filter, niet enkel de al-geladen schermpagina.
   *
   * Registreert zelf ook een auditlog-regel (`AUDIT_LOG_EXPORTED`) — wie de
   * auditlog exporteerde is voor dit gebruik zelf ook een relevant, later
   * controleerbaar feit.
   */
  app.get(
    '/admin/audit-log/export',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const query = auditLogFilterQuerySchema.parse(request.query);
      const filters = {
        entityType: query.entityType,
        actorUserId: query.actorUserId,
        action: query.action,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      };
      const entries = await service.list({ ...filters, limit: EXPORT_LIMIT, order: 'asc' as const });
      const filterDescription = describeFilters(query);
      const buffer = await buildAuditLogWorkbook(entries, filterDescription);

      await service.record({
        actorUserId: request.currentUser?.id ?? null,
        action: 'AUDIT_LOG_EXPORTED',
        entityType: 'AuditLog',
        entityId: 'export',
        metadata: { ...query, rowCount: entries.length },
      });

      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="auditlog-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
      return reply.send(buffer);
    },
  );
}

function describeFilters(query: z.infer<typeof auditLogFilterQuerySchema>): string {
  const parts: string[] = [];
  parts.push(`Type: ${query.entityType ?? 'alle'}`);
  parts.push(`Actie: ${query.action ? (AUDIT_LOG_ACTION_LABELS[query.action] ?? query.action) : 'alle'}`);
  parts.push(`Door: ${query.actorUserId ?? 'alle gebruikers'}`);
  parts.push(`Van: ${query.from ?? '(geen ondergrens)'}`);
  parts.push(`Tot: ${query.to ?? '(geen bovengrens)'}`);
  return parts.join(' — ');
}

function toSummary(entry: AuditLogRecord): AuditLogEntrySummary {
  return {
    id: entry.id,
    actorDisplayName: entry.actorUser?.employee?.displayName ?? entry.actorUser?.email ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata,
    createdAt: entry.createdAt.toISOString(),
  };
}
