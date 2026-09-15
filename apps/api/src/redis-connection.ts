import IORedis from 'ioredis';
import { env } from './config/env';

let connection: IORedis | null = null;

/**
 * Fase 32 (klantvraag 15/9/2026 — rate limiting) — lazy Redis-verbinding
 * voor de rate-limiter (`plugins/rate-limit.ts`), zodat de limiet correct
 * blijft werken over een herstart heen, en straks over meerdere
 * gelijktijdige instanties (i.p.v. de in-memory default van
 * `@fastify/rate-limit`, die dat niet doet).
 *
 * Bewust een aparte verbinding van `queue/queue.ts` (Fase 9, BullMQ), niet
 * hergebruikt: die verbinding is intern aan de queue-module (geen export),
 * en er zonder noodzaak aan raken zou een werkend, bestaand onderdeel
 * kunnen beïnvloeden voor een marginaal voordeel (één Redis-connectie
 * minder) — één extra lichte connectie naar dezelfde Render Key-Value-
 * instance is een aanvaardbare kost.
 *
 * `lazyConnect: true`: verbindt pas bij het eerste effectieve gebruik, niet
 * meteen bij het importeren van deze module (zelfde reden als in queue.ts:
 * `app.ts` laadt dit transitief in elke test, ook wanneer die test nooit
 * een rate-limit-pad raakt).
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    connection.on('error', (err) => {
      // eslint-disable-next-line no-console -- bewust: zichtbaar in de server-log wanneer Redis (tijdelijk) onbereikbaar is.
      console.error('[redis] Verbindingsfout', err.message);
    });
  }
  return connection;
}
