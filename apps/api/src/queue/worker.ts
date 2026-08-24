import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import { env } from '../config/env';
import { DatabaseStorageService } from '../modules/storage/storage.service';
import { SyncJobService } from '../modules/sync/sync-job.service';
import { FileSyncService } from '../modules/teamleader/file-sync.service';
import { MilestoneSyncService } from '../modules/teamleader/milestone-sync.service';
import { TeamleaderAuthService } from '../modules/teamleader/teamleader-auth.service';
import { TeamleaderClient } from '../modules/teamleader/teamleader-client.service';
import { TimeTrackingSyncService } from '../modules/teamleader/time-tracking-sync.service';
import { SYNC_QUEUE_NAME, type SyncQueueJobData } from './queue';

/**
 * Phase 9 — apart procesentrypoint voor de achtergrondwerker (sectie 15),
 * bewust GESCHEIDEN van de gewone API-server (server.ts): de werker roept
 * Teamleader aan en kan dus trager/onbetrouwbaarder zijn dan een gewone
 * HTTP-request, en een crash hierin mag de webdienst zelf nooit meesleuren.
 * Zie render.yaml voor de aparte "worker"-service die dit bestand als
 * startCommand gebruikt (`node dist/queue/worker.js`).
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const teamleaderAuthService = new TeamleaderAuthService(prisma);
  const teamleaderClient = new TeamleaderClient(teamleaderAuthService);
  const storage = new DatabaseStorageService(prisma);
  const milestoneSyncService = new MilestoneSyncService(prisma, teamleaderClient);
  const timeTrackingSyncService = new TimeTrackingSyncService(prisma, teamleaderClient, milestoneSyncService);
  const fileSyncService = new FileSyncService(prisma, teamleaderClient, storage);
  const syncJobService = new SyncJobService(prisma, timeTrackingSyncService, fileSyncService);

  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<SyncQueueJobData>(
    SYNC_QUEUE_NAME,
    async (job) => {
      await syncJobService.processJob(job.data.workOrderId, job.data.type);
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] job ${job?.id ?? '?'} (${job?.data.type ?? '?'} / werkbon ${job?.data.workOrderId ?? '?'}) mislukt`, err.message);
  });
  worker.on('completed', (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] job ${job.id} (${job.data.type} / werkbon ${job.data.workOrderId}) geslaagd`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      // eslint-disable-next-line no-console
      console.log(`${signal} ontvangen, worker wordt afgesloten...`);
      await worker.close();
      await connection.quit().catch(() => {});
      await prisma.$disconnect();
      process.exit(0);
    });
  }
}

void main();
