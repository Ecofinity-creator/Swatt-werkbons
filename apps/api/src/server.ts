import { buildApp } from './app';
import { env } from './config/env';

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

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      app.log.info(`${signal} ontvangen, server wordt afgesloten...`);
      await app.close();
      process.exit(0);
    });
  }
}

void main();
