import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuditLogEntrySummary, ListAuditLogResponseBody } from '@swatt/shared-types';
import { requireRole } from '../rbac/rbac.middleware';
import { AuditLogService, type AuditLogRecord } from './audit-log.service';

const listAuditLogQuerySchema = z.object({
  entityType: z.string().trim().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Op vraag (3/9/2026): "auditlog-scherm, om bij een geschil te zien wie iets
 * wanneer gewijzigd heeft" — sectie 23/26 uit de oorspronkelijke projectbrief.
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
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      });
      return { entries: entries.map(toSummary) };
    },
  );
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
