import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '../config/env';

/** Body van elke job op deze queue — genoeg om SyncJobService.processJob() opnieuw op te zoeken welke rij het betreft. */
export interface SyncQueueJobData {
  workOrderId: string;
  type: 'TIME_ENTRIES' | 'PDF_UPLOAD';
}

export const SYNC_QUEUE_NAME = 'teamleader-sync';

let connection: IORedis | null = null;
let queue: Queue<SyncQueueJobData> | null = null;

/**
 * Phase 9 — Redis-verbinding voor BullMQ (sectie 15: "Gebruik een robuuste
 * job queue voor Teamleader sync en PDF processing"). `lazyConnect: true`
 * zodat het enkel effectief verbindt bij het eerste gebruik (niet meteen bij
 * het importeren van deze module) — belangrijk omdat `app.ts` (en dus elke
 * test die de app opbouwt) deze module transitief laadt via work-order.routes.ts,
 * ook wanneer die specifieke test nooit een sync-actie triggert.
 * `maxRetriesPerRequest: null` is een harde BullMQ-vereiste voor de
 * queue-verbinding (anders faalt blocking-gedrag intern).
 */
function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    connection.on('error', (err) => {
      // eslint-disable-next-line no-console -- bewust: zichtbaar in de server-log wanneer Redis (tijdelijk) onbereikbaar is; zie SyncJobService.tryEnqueue voor de "nooit dataverlies"-afhandeling daarvan.
      console.error('[queue] Redis-verbindingsfout', err.message);
    });
  }
  return connection;
}

export function getSyncQueue(): Queue<SyncQueueJobData> {
  if (!queue) {
    queue = new Queue<SyncQueueJobData>(SYNC_QUEUE_NAME, { connection: getConnection() });
  }
  return queue;
}

/** Voor een nette shutdown (server.ts) en tests. */
export async function closeQueue(): Promise<void> {
  await queue?.close();
  queue = null;
  if (connection) {
    await connection.quit().catch(() => {
      // Best effort — bij een reeds verbroken verbinding is er niets meer te sluiten.
    });
    connection = null;
  }
}
