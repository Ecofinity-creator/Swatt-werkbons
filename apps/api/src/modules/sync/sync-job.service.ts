import type { PrismaClient } from '@prisma/client';
import type { FileSyncService } from '../teamleader/file-sync.service';
import type { TimeTrackingSyncService } from '../teamleader/time-tracking-sync.service';
import { getSyncQueue, type SyncQueueJobData } from '../../queue/queue';

/** Zelfde patroon als WorkOrderRecord.status e.d. elders in de codebase: een handgeschreven union i.p.v. het Prisma-gegenereerde enum-type rechtstreeks te importeren. */
export type SyncJobType = 'TIME_ENTRIES' | 'PDF_UPLOAD';

const SYNC_JOB_TYPES: SyncJobType[] = ['TIME_ENTRIES', 'PDF_UPLOAD'];

/**
 * Phase 9 — sectie 15/23: TeamleaderSyncService-achtige orchestratielaag
 * (hier `SyncJobService` genoemd, om verwarring met `TeamleaderClient`/
 * `*SyncService` in modules/teamleader/ te vermijden). Verantwoordelijk voor:
 * - het aanmaken/bijwerken van de durable `SyncJob`-rijen (Postgres, overleeft
 *   een lege Redis-queue — business rule 9);
 * - het (best-effort) op de BullMQ-queue plaatsen van het eigenlijke werk;
 * - het effectief uitvoeren van één job (aangeroepen door de worker, zie
 *   queue/worker.ts) en het bijwerken van SyncJob/SyncLog + de afgeleide
 *   WorkOrder.status (sectie 34, stap 9: SIGNED → ... → READY_FOR_INVOICING).
 */
export class SyncJobService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly timeTrackingSync: TimeTrackingSyncService,
    private readonly fileSync: FileSyncService,
  ) {}

  /** Aangeroepen meteen na een geslaagde /sign (sectie 34, stappen 6-8) — maakt/hergebruikt beide SyncJob-rijen en plant ze in. */
  async enqueueForWorkOrder(workOrderId: string): Promise<void> {
    for (const type of SYNC_JOB_TYPES) {
      const job = await this.prisma.syncJob.upsert({
        where: { workOrderId_type: { workOrderId, type } },
        create: { workOrderId, type, status: 'PENDING' },
        update: { status: 'PENDING', lastError: null },
      });
      await this.tryEnqueue(job.id, workOrderId, type);
    }
    await this.setWorkOrderPendingIfNotTerminal(workOrderId);
  }

  /**
   * Herstelactie (sectie 13: "Administrator moet handmatig: Opnieuw
   * synchroniseren kunnen kiezen"). Plant enkel de nog-niet-geslaagde jobs
   * opnieuw in — een reeds SUCCEEDED job (bv. de PDF stond al goed in
   * Teamleader terwijl enkel de uren mislukten) wordt niet nodeloos herhaald.
   * Als er om welke reden dan ook nog geen SyncJob-rijen bestaan (zou niet
   * mogen voorkomen zodra /sign altijd enqueueForWorkOrder aanroept), valt
   * dit terug op een volledige (her)aanmaak.
   */
  async retry(workOrderId: string): Promise<void> {
    const existing = await this.prisma.syncJob.findMany({ where: { workOrderId } });
    if (existing.length === 0) {
      await this.enqueueForWorkOrder(workOrderId);
      return;
    }
    for (const job of existing) {
      if (job.status === 'SUCCEEDED') continue;
      await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'PENDING', lastError: null } });
      await this.tryEnqueue(job.id, workOrderId, job.type);
    }
    await this.setWorkOrderPendingIfNotTerminal(workOrderId);
  }

  /**
   * Herqueue alle SyncJob-rijen die nog niet afgerond zijn — bedoeld om bij
   * het opstarten van de API-server aangeroepen te worden (zie app.ts), zodat
   * een job die aangemaakt werd terwijl Redis tijdelijk onbereikbaar was
   * (`tryEnqueue` faalde toen stil) alsnog effectief verwerkt wordt zonder
   * dat een admin daarvoor handmatig "opnieuw synchroniseren" moet klikken.
   */
  async reconcilePendingJobs(): Promise<number> {
    const jobs = await this.prisma.syncJob.findMany({ where: { status: { in: ['PENDING', 'PROCESSING'] } } });
    for (const job of jobs) {
      // Een job die bij een vorige server-crash op PROCESSING bleef staan,
      // wordt hier teruggezet naar PENDING vóór herqueuing — anders zou een
      // volgende "opnieuw synchroniseren"-klik hem overslaan (retry() slaat
      // enkel SUCCEEDED over, dus dit is vooral voor de duidelijkheid van de
      // sync-status in de UI tijdens deze herstelronde).
      if (job.status === 'PROCESSING') {
        await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'PENDING' } });
      }
      await this.tryEnqueue(job.id, job.workOrderId, job.type);
    }
    return jobs.length;
  }

  /** Best-effort push naar BullMQ. Faalt deze (bv. Redis tijdelijk onbereikbaar), dan blijft de SyncJob-rij gewoon PENDING in Postgres (business rule 9) — reconcilePendingJobs() haalt dit later in. */
  private async tryEnqueue(syncJobId: string, workOrderId: string, type: SyncJobType): Promise<void> {
    try {
      const data: SyncQueueJobData = { workOrderId, type };
      await getSyncQueue().add(type, data, {
        jobId: syncJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 dagen — genoeg om kort na te kijken, geen onbeperkte Redis-groei
        removeOnFail: { age: 60 * 60 * 24 * 30 },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[SyncJobService] Kon syncjob ${syncJobId} (${type}) niet op de queue plaatsen — blijft PENDING, wordt bij de volgende serverstart herprobeerd`, err);
    }
  }

  /** Uitgevoerd door de worker (queue/worker.ts) voor één specifieke job. */
  async processJob(workOrderId: string, type: SyncJobType): Promise<void> {
    const job = await this.prisma.syncJob.findUnique({ where: { workOrderId_type: { workOrderId, type } } });
    if (!job) return; // defensief — kan niet voorkomen zolang enqueueForWorkOrder altijd eerst de rij aanmaakt

    const attempt = job.attempts + 1;
    await this.prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'PROCESSING', attempts: attempt, lastAttemptedAt: new Date() },
    });
    await this.log(job.id, attempt, 'STARTED', 'Synchronisatie gestart.');

    const result = type === 'TIME_ENTRIES' ? await this.timeTrackingSync.syncWorkOrder(workOrderId) : await this.fileSync.uploadPdf(workOrderId);

    if (result.success) {
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: null },
      });
      await this.log(job.id, attempt, 'SUCCEEDED', successMessage(type));
    } else {
      const message = result.message ?? 'Onbekende fout tijdens synchronisatie.';
      await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: message } });
      await this.log(job.id, attempt, 'FAILED', message);
    }

    await this.recomputeWorkOrderStatus(workOrderId);

    if (!result.success) {
      // Laat BullMQ zijn eigen retry-mechanisme (attempts/backoff, zie
      // tryEnqueue) toepassen door de job als mislukt te laten gelden.
      throw new Error(result.message ?? 'Synchronisatie mislukt.');
    }
  }

  /**
   * Bepaalt WorkOrder.status uit de échte bronvelden (WorkOrder.teamleaderUploadStatus
   * + de TimeEntry.syncStatus-verzameling) — niet uit SyncJob.status, dat is
   * puur operationeel/audit. Nooit terugdraaien vanaf INVOICED (business rule 7).
   */
  private async recomputeWorkOrderStatus(workOrderId: string): Promise<void> {
    const workOrder = await this.prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrderId },
      include: { timeEntries: { include: { timeEntry: true } } },
    });
    if (workOrder.status === 'INVOICED') return;

    const timeSyncStatuses = workOrder.timeEntries.map((link: { timeEntry: { syncStatus: string } }) => link.timeEntry.syncStatus);
    const timeSynced = timeSyncStatuses.length === 0 || timeSyncStatuses.every((status: string) => status === 'SYNCED');
    const timeFailed = timeSyncStatuses.some((status: string) => status === 'FAILED');
    const uploadDone = workOrder.teamleaderUploadStatus === 'TEAMLEADER_UPLOADED';
    const uploadFailed = workOrder.teamleaderUploadStatus === 'TEAMLEADER_UPLOAD_FAILED';

    let nextStatus: 'SYNC_PENDING' | 'SYNC_FAILED' | 'READY_FOR_INVOICING';
    if (timeSynced && uploadDone) {
      nextStatus = 'READY_FOR_INVOICING';
    } else if (timeFailed || uploadFailed) {
      nextStatus = 'SYNC_FAILED';
    } else {
      nextStatus = 'SYNC_PENDING';
    }

    if (workOrder.status !== nextStatus) {
      await this.prisma.workOrder.update({ where: { id: workOrderId }, data: { status: nextStatus } });
    }
  }

  private async setWorkOrderPendingIfNotTerminal(workOrderId: string): Promise<void> {
    const workOrder = await this.prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId } });
    if (workOrder.status === 'INVOICED' || workOrder.status === 'READY_FOR_INVOICING') return;
    await this.prisma.workOrder.update({ where: { id: workOrderId }, data: { status: 'SYNC_PENDING' } });
  }

  private async log(syncJobId: string, attempt: number, status: 'STARTED' | 'SUCCEEDED' | 'FAILED', message: string): Promise<void> {
    await this.prisma.syncLog.create({ data: { syncJobId, attempt, status, message } });
  }
}

function successMessage(type: SyncJobType): string {
  return type === 'TIME_ENTRIES' ? 'Tijdsregistraties gesynchroniseerd naar Teamleader.' : 'PDF geüpload naar Teamleader.';
}
