import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Op vraag (3/9/2026): "auditlog-scherm, om bij een geschil te zien wie iets
 * wanneer gewijzigd heeft" — sectie 23/26 uit de oorspronkelijke projectbrief.
 * Zie AuditLog in schema.prisma voor de volledige toelichting bij het
 * datamodel (bewust generiek, geen FK naar de onderliggende entiteit).
 *
 * Bewust een heel dunne service (één `record()`-methode) i.p.v. een aparte
 * klasse per entiteitstype — elke aanroeper (WorkOrderSignatureService,
 * PayrollService, ...) roept dit rechtstreeks aan op het moment van de
 * effectieve wijziging. `record()` gooit zelf nooit — een falende audit-log-
 * schrijving mag de eigenlijke actie (bv. een ondertekening) nooit laten
 * mislukken (business rule 9-analoog: een neveneffect mag de hoofdactie niet
 * in gevaar brengen). Fouten worden enkel gelogd naar console, niet
 * doorgegooid.
 */
export class AuditLogService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: {
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          // `exactOptionalPropertyTypes: true` verbiedt een sleutel expliciet
          // op `undefined` te zetten voor een optioneel Prisma-inputveld (dat
          // is iets anders dan de sleutel gewoon weglaten) — vandaar de
          // conditionele spread i.p.v. `metadata: entry.metadata ?? undefined`
          // (zelfde patroon als elders in deze codebase, bv.
          // company-settings.service.ts se toelichting bij optionele velden).
          // De cast naar `Prisma.InputJsonValue` blijft nodig omdat
          // `Record<string, unknown>` structureel niet identiek is aan dat
          // type (dat enkel gegarandeerd JSON-serialiseerbare waarden
          // toelaat) — veilig hier, elke aanroeper geeft effectief platte,
          // JSON-serialiseerbare metadata mee.
          ...(entry.metadata !== undefined ? { metadata: entry.metadata as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('AuditLogService.record() mislukt (actie zelf gaat gewoon door):', err);
    }
  }

  /**
   * Doorzoekbare auditlog (klantvraag 13/9/2026 — "een doorzoekbare
   * auditlog-UI... sterk richting bedrijven die met aanbestedingen of
   * verzekeringsvereisten werken"). `action` en `before` zijn nieuw t.o.v.
   * de oorspronkelijke versie:
   * - `action`: exacte match op de actiecode (zie AUDIT_LOG_ACTION_LABELS
   *   in shared-types), voor het "Actie"-filter op AuditLogPage.tsx.
   * - `before`: cursor voor "Meer laden" — enkel rijen strikt vóór dit
   *   tijdstip. Werkt samen met `from`/`to` (allebei mogen tegelijk gezet
   *   zijn, Prisma combineert meerdere operatoren op hetzelfde veld
   *   probleemloos in één `createdAt`-object).
   * - `order`: 'desc' (standaard, voor het scherm zelf — nieuwste eerst)
   *   of 'asc' (voor de Excel-export hieronder — chronologisch leesbaar
   *   voor een auditor/verzekeraar).
   */
  async list(filters: {
    entityType?: string | undefined;
    actorUserId?: string | undefined;
    action?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    before?: Date | undefined;
    limit?: number | undefined;
    order?: 'asc' | 'desc' | undefined;
  } = {}): Promise<AuditLogRecord[]> {
    const hasDateFilter = Boolean(filters.from || filters.to || filters.before);
    return this.prisma.auditLog.findMany({
      where: {
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(hasDateFilter
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
                ...(filters.before ? { lt: filters.before } : {}),
              },
            }
          : {}),
      },
      include: { actorUser: { select: { email: true, employee: { select: { displayName: true } } } } },
      orderBy: { createdAt: filters.order ?? 'desc' },
      take: filters.limit ?? 200,
    }) as unknown as Promise<AuditLogRecord[]>;
  }
}

export interface AuditLogRecord {
  id: string;
  actorUserId: string | null;
  actorUser: { email: string; employee: { displayName: string } | null } | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
