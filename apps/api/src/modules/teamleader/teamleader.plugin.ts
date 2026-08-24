import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { SyncJobService } from '../sync/sync-job.service';
import { FileSyncService } from './file-sync.service';
import { MilestoneSyncService } from './milestone-sync.service';
import { ProjectSyncService } from './project-sync.service';
import { TeamleaderAuthService } from './teamleader-auth.service';
import { TeamleaderClient } from './teamleader-client.service';
import { TeamleaderUserService } from './teamleader-user.service';
import { TimeTrackingSyncService } from './time-tracking-sync.service';
import { DatabaseStorageService } from '../storage/storage.service';

declare module 'fastify' {
  interface FastifyInstance {
    teamleaderAuthService: TeamleaderAuthService;
    /** Generieke, geauthenticeerde laag voor Teamleader REST/RPC-calls — zie teamleader-client.service.ts. */
    teamleaderClient: TeamleaderClient;
    /** Phase 3 (slice) — synct Teamleader-projecten + hun klant naar de lokale cache. */
    projectSyncService: ProjectSyncService;
    /** Phase 9 — live users.list-opvraging voor de medewerker↔Teamleader-gebruiker-koppeling. */
    teamleaderUserService: TeamleaderUserService;
    /** Phase 9 — legacy-milestones per project (zie milestone-sync.service.ts). */
    milestoneSyncService: MilestoneSyncService;
    /** Phase 9 — orchestreert TIME_ENTRIES/PDF_UPLOAD-syncjobs (queue + durable SyncJob/SyncLog). */
    syncJobService: SyncJobService;
  }
}

/**
 * Zelfde patroon als auth.plugin.ts: gedeelde service-instanties,
 * gedecoreerd op `app` zodat routes en andere sync-modules er zonder eigen
 * constructie bij kunnen.
 */
export default fp(async function teamleaderPlugin(app: FastifyInstance) {
  const teamleaderAuthService = new TeamleaderAuthService(app.prisma);
  const teamleaderClient = new TeamleaderClient(teamleaderAuthService);
  const storage = new DatabaseStorageService(app.prisma);
  const milestoneSyncService = new MilestoneSyncService(app.prisma, teamleaderClient);
  const timeTrackingSyncService = new TimeTrackingSyncService(app.prisma, teamleaderClient, milestoneSyncService);
  const fileSyncService = new FileSyncService(app.prisma, teamleaderClient, storage);

  app.decorate('teamleaderAuthService', teamleaderAuthService);
  app.decorate('teamleaderClient', teamleaderClient);
  app.decorate('projectSyncService', new ProjectSyncService(app.prisma, teamleaderClient));
  app.decorate('teamleaderUserService', new TeamleaderUserService(teamleaderClient));
  app.decorate('milestoneSyncService', milestoneSyncService);
  app.decorate('syncJobService', new SyncJobService(app.prisma, timeTrackingSyncService, fileSyncService));
});
