import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { TeamleaderAuthService } from './teamleader-auth.service';

declare module 'fastify' {
  interface FastifyInstance {
    teamleaderAuthService: TeamleaderAuthService;
  }
}

/**
 * Zelfde patroon als auth.plugin.ts: één gedeelde service-instantie,
 * gedecoreerd op `app` zodat routes en (vanaf Phase 3) andere sync-modules
 * er zonder eigen constructie bij kunnen.
 */
export default fp(async function teamleaderPlugin(app: FastifyInstance) {
  app.decorate('teamleaderAuthService', new TeamleaderAuthService(app.prisma));
});
