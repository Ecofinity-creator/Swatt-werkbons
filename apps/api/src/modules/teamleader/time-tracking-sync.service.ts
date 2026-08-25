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
        started_at: toTeamleaderTimestamp(entry.startedAt),
        duration: durationSeconds,
        description: buildTeamleaderDescription(entry.employee.displayName, entry.description, workOrder.description),
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

/**
 * `timeTracking.add` vereist per het officiële blueprint een `started_at`
 * die exact matcht met het getoonde voorbeeldformaat (`2017-04-26T10:01:49+00:00`)
 * — géén milliseconden, en een expliciete `+00:00`-offset i.p.v. de letterlijke
 * `Z` die JavaScripts `Date.toISOString()` altijd teruggeeft
 * (`2026-08-25T06:57:21.628Z`). Live bevestigd: Teamleader wees dat laatste
 * formaat consequent af met "started_at must be valid" (zie
 * Synchronisatiefouten, WB-2026-000006) — geen documentatie-detail dat
 * genegeerd kon worden, dit blokkeerde ELKE tijdregistratie-sync.
 */
function toTeamleaderTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Alle technieker-uploads lopen bewust via één gedeeld Teamleader-account
 * (Isabel) i.p.v. een apart betaald Teamleader-gebruikersaccount per
 * technieker — Swatt wil precies dat die per-gebruiker-kost bij Teamleader
 * vermijden. `user_id` in de timeTracking.add-payload wijst daardoor altijd
 * naar dat ene gedeelde account, dus de "Gebruiker"-kolom in Teamleaders
 * eigen timesheet-rapport toont nooit de échte uitvoerder. Live bevestigd
 * (screenshot "Rapport timesheets", 2026-08-24): alle uren stonden correct,
 * maar allemaal onder "Isabel Menschaert".
 *
 * Expliciet gevraagd door Steven: de volledige naam van de werkelijke
 * uitvoerder moet daarom in het `description`-veld zelf terechtkomen, zodat
 * die minstens zichtbaar blijft in Teamleaders rapportage. We zetten de naam
 * vooraan (niet enkel als losse toevoeging onderaan) zodat hij ook zichtbaar
 * blijft wanneer Teamleader een lange omschrijving in een rapport afkapt.
 * Wanneer er geen eigen omschrijving is (noch op de tijdsregistratie, noch op
 * de werkbon), sturen we enkel de naam door — nooit een lege of "undefined"-
 * achtige tekst na de naam.
 */
function buildTeamleaderDescription(employeeName: string, entryDescription: string | null, workOrderDescription: string | null): string {
  const text = entryDescription ?? workOrderDescription ?? null;
  return text ? `${employeeName} — ${text}` : employeeName;
}
