import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ProjectSyncService } from './project-sync.service';
import { TeamleaderAuthService } from './teamleader-auth.service';
import { TeamleaderClient } from './teamleader-client.service';

declare module 'fastify' {
  interface FastifyInstance {
    teamleaderAuthService: TeamleaderAuthService;
    /** Generieke, geauthenticeerde laag voor Teamleader REST/RPC-calls — zie teamleader-client.service.ts. */
    teamleaderClient: TeamleaderClient;
    /** Phase 3 (slice) — synct Teamleader-projecten + hun klant naar de lokale cache. */
    projectSyncService: ProjectSyncService;
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

  app.decorate('teamleaderAuthService', teamleaderAuthService);
  app.decorate('teamleaderClient', teamleaderClient);
  app.decorate('projectSyncService', new ProjectSyncService(app.prisma, teamleaderClient));
});
