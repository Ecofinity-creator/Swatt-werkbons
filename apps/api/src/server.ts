import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { buildApp } from './app';
import { env } from './config/env';
import { SYNC_QUEUE_NAME, type SyncQueueJobData } from './queue/queue';

async function main(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Phase 9 — herqueue elke SyncJob die nog niet afgerond is (sectie 15/23):
  // vangt zowel jobs op die bij een vorige server-crash halverwege bleven
  // staan, als jobs waarvan de oorspronkelijke `tryEnqueue`-poging faalde
  // omdat Redis op dat moment tijdelijk onbereikbaar was (business rule 9 —
  // die jobs bleven gewoon PENDING in Postgres, zie SyncJobService). Bewust
  // ná `listen()` en niet-blokkerend (`void`): de webdienst mag nooit
  // wachten op — of falen door — deze herstelronde.
  void app.syncJobService.reconcilePendingJobs().catch((err: unknown) => {
    app.log.error({ err }, 'Herqueuen van openstaande syncjobs bij opstart is mislukt');
  });

  // Demo-/testmodus (RUN_SYNC_WORKER_INLINE, zie config/env.ts): laat de
  // BullMQ-syncwerker meedraaien in dit proces i.p.v. als aparte
  // `swatt-sync-worker`-service (queue/worker.ts) — nodig omdat Render's
  // gratis plan geen Background Worker-services ondersteunt. Redis (de
  // wachtrij zelf, `swatt-redis`) draait sowieso al gratis; hier ontbrak
  // enkel een consument. Hergebruikt bewust `app.syncJobService`/`app.prisma`
  // i.p.v. een eigen Prisma/Teamleader-stack zoals de standalone worker doet
  // — één databaseverbinding minder, en geen risico op afwijkende config.
  // BELANGRIJK: enkel voor demo/test. Bij echt klantvolume dit uitzetten en
  // de aparte (betaalde) swatt-sync-worker-service gebruiken — anders deelt
  // de Teamleader-sync CPU/geheugen met de webrequests van diezelfde dienst.
  let inlineWorker: Worker<SyncQueueJobData> | null = null;
  let inlineWorkerConnection: IORedis | null = null;
  if (env.RUN_SYNC_WORKER_INLINE) {
    inlineWorkerConnection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    inlineWorker = new Worker<SyncQueueJobData>(
      SYNC_QUEUE_NAME,
      async (job) => {
        await app.syncJobService.processJob(job.data.workOrderId, job.data.type);
      },
      { connection: inlineWorkerConnection, concurrency: 2 },
    );
    inlineWorker.on('failed', (job, err) => {
      app.log.error({ err, jobId: job?.id }, '[inline-worker] Teamleader-syncjob mislukt');
    });
    inlineWorker.on('completed', (job) => {
      app.log.info({ jobId: job.id }, '[inline-worker] Teamleader-syncjob voltooid');
    });
    app.log.warn(
      'RUN_SYNC_WORKER_INLINE staat aan: de Teamleader-syncwerker draait in hetzelfde proces als de API. ' +
        'Enkel bedoeld voor demo/test — zet dit uit zodra swatt-sync-worker als aparte (betaalde) service draait.',
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      app.log.info(`${signal} ontvangen, server wordt afgesloten...`);
      await inlineWorker?.close();
      await inlineWorkerConnection?.quit().catch(() => {
        // Best effort — bij een reeds verbroken verbinding is er niets meer te sluiten.
      });
      await app.close();
      process.exit(0);
    });
  }
}

void main();
