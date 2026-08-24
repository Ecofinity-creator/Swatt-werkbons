import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { TeamleaderErrors } from '../../errors';
import type { MilestoneSyncService } from './milestone-sync.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

export interface SyncResult {
  success: boolean;
  /** Mensentaal-boodschap (sectie 27) — enkel gezet wanneer success === false. */
  message: string | null;
}

interface TimeTrackingAddResponse {
  data: { id: string };
}

const WITH_SYNC_DETAILS = {
  include: {
    project: true,
    timeEntries: {
      include: {
        timeEntry: { include: { employee: { include: { user: true } } } },
      },
    },
  },
} as const;

/** Vorm van één rij in `workOrder.timeEntries` onder WITH_SYNC_DETAILS hierboven — handgeschreven i.p.v. het Prisma-gegenereerde type, zelfde patroon als elders in de codebase (bv. WorkOrderRecord in work-order.service.ts). */
interface WorkOrderTimeEntryLink {
  timeEntry: {
    id: string;
    startedAt: Date;
    endedAt: Date | null;
    pausedSeconds: number;
    description: string | null;
    syncStatus: string;
    employee: { displayName: string; user: { teamleaderUserId: string | null } };
  };
}

/**
 * Phase 9 — sectie 14: gesynchroniseerde tijdregistraties via `timeTracking.add`.
 *
 * BELANGRIJK, geverifieerd tegen het officiële blueprint: `subject.type` moet
 * `milestone` zijn (niet `project` — sinds 2019 niet meer toegestaan, zie
 * MilestoneSyncService). We gebruiken bewust `started_at` + `duration`
 * (i.p.v. `started_at` + `ended_at`) zodat de reeds afgetrokken pauzetijd
 * (`TimeEntry.pausedSeconds`, sectie 6/8) correct meetelt — met
 * `started_at`+`ended_at` zou Teamleader de volledige wandklok-tijdspanne
 * inclusief pauzes als gewerkte tijd registreren.
 *
 * Idempotent (business rule 5): een tijdsregistratie met syncStatus SYNCED
 * wordt altijd overgeslagen, nooit opnieuw gepost — dit geldt ook bij een
 * herhaalde "opnieuw synchroniseren"-aanvraag (SyncJobService roept dezelfde
 * `syncWorkOrder()` telkens opnieuw aan; enkel de nog niet gesynchroniseerde
 * of eerder mislukte registraties worden dan effectief verstuurd).
 *
 * Volgt hetzelfde patroon als WorkOrderPdfService: gooit nooit verder voor
 * "verwachte" Teamleader-fouten — die worden per tijdsregistratie afgevangen
 * en opgeslagen (TimeEntry.syncStatus/syncError), zodat één mislukte
 * registratie de andere(n) niet blokkeert. Het aggregaat-resultaat (success/
 * message) is voor SyncJobService, dat de SyncJob/SyncLog-boekhouding bijhoudt.
 */
export class TimeTrackingSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: TeamleaderClient,
    private readonly milestoneSync: MilestoneSyncService,
  ) {}

  async syncWorkOrder(workOrderId: string): Promise<SyncResult> {
    const workOrder = await this.prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrderId },
      ...WITH_SYNC_DETAILS,
    });

    const entries = (workOrder.timeEntries as WorkOrderTimeEntryLink[]).map((link) => link.timeEntry);
    const pending = entries.filter((entry) => entry.syncStatus !== 'SYNCED');
    if (pending.length === 0) {
      return { success: true, message: null };
    }

    let milestoneTeamleaderId: string;
    try {
      milestoneTeamleaderId = await this.milestoneSync.resolveOrCreateTeamleaderMilestoneId(workOrder.projectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Onbekende fout bij het bepalen van de Teamleader-milestone.';
      await this.prisma.timeEntry.updateMany({
        where: { id: { in: pending.map((entry) => entry.id) } },
        data: { syncStatus: 'FAILED', syncError: message },
      });
      return { success: false, message };
    }

    let firstErrorMessage: string | null = null;

    for (const entry of pending) {
      const teamleaderUserId = entry.employee.user.teamleaderUserId;
      if (!teamleaderUserId) {
        const message = TeamleaderErrors.employeeNotLinkedToTeamleaderUser(entry.employee.displayName).message;
        await this.prisma.timeEntry.update({ where: { id: entry.id }, data: { syncStatus: 'FAILED', syncError: message } });
        firstErrorMessage ??= message;
        continue;
      }
      if (!entry.endedAt) {
        // Kan in de praktijk niet voorkomen — enkel gestopte tijdsregistraties
        // worden ooit aan een werkbon gekoppeld (zie WorkOrderService.create).
        continue;
      }

      const durationSeconds = Math.max(
        0,
        Math.round((entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000) - entry.pausedSeconds,
      );
      const payload = {
        started_at: entry.startedAt.toISOString(),
        duration: durationSeconds,
        description: entry.description ?? workOrder.description ?? undefined,
        subject: { type: 'milestone' as const, id: milestoneTeamleaderId },
        invoiceable: true,
        user_id: teamleaderUserId,
      };
      const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

      try {
        const response = await this.client.post<TimeTrackingAddResponse>('timeTracking.add', payload);
        await this.prisma.timeEntry.update({
          where: { id: entry.id },
          data: {
            syncStatus: 'SYNCED',
            teamleaderTimeTrackingId: response.data.id,
            syncedAt: new Date(),
            syncPayloadHash: payloadHash,
            syncError: null,
          },
        });
      } catch (err) {
        const message =
          err instanceof TeamleaderApiError
            ? TeamleaderErrors.syncFailed(err.message).message
            : TeamleaderErrors.syncFailed('onbekende fout').message;
        await this.prisma.timeEntry.update({
          where: { id: entry.id },
          data: { syncStatus: 'FAILED', syncPayloadHash: payloadHash, syncError: message },
        });
        firstErrorMessage ??= message;
      }
    }

    return firstErrorMessage ? { success: false, message: firstErrorMessage } : { success: true, message: null };
  }
}
