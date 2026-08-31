import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { getDistanceServiceApiKey, isDistanceServiceConfigured } from '../../config/env';
import { SyncJobService } from '../sync/sync-job.service';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { OpenRouteServiceDistanceProvider } from '../distance/distance.service';
import { FileSyncService } from './file-sync.service';
import { MilestoneSyncService } from './milestone-sync.service';
import { ProjectSyncService } from './project-sync.service';
import { TeamleaderAuthService } from './teamleader-auth.service';
import { TeamleaderClient } from './teamleader-client.service';
import { TeamleaderInvoiceOptionsService } from './teamleader-invoice-options.service';
import { TeamleaderInvoiceService } from './teamleader-invoice.service';
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
    /** Phase 10b — live departments.list/taxRates.list/paymentTerms.list-opvraging voor het facturatie-instellingenscherm. */
    teamleaderInvoiceOptionsService: TeamleaderInvoiceOptionsService;
    /** Phase 10b — "Maak conceptfactuur in Teamleader" (invoices.draft), zie teamleader-invoice.service.ts. */
    teamleaderInvoiceService: TeamleaderInvoiceService;
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
  // Phase 12, deel D — beide optioneel (zie ProjectSyncService); zonder
  // OPENROUTESERVICE_API_KEY blijft de projectsync zelf gewoon werken.
  const distanceService = isDistanceServiceConfigured() ? new OpenRouteServiceDistanceProvider(getDistanceServiceApiKey()) : null;
  const companySettingsService = new CompanySettingsService(app.prisma);
  app.decorate('projectSyncService', new ProjectSyncService(app.prisma, teamleaderClient, distanceService, companySettingsService));
  app.decorate('teamleaderUserService', new TeamleaderUserService(teamleaderClient));
  app.decorate('milestoneSyncService', milestoneSyncService);
  app.decorate('syncJobService', new SyncJobService(app.prisma, timeTrackingSyncService, fileSyncService));
  app.decorate('teamleaderInvoiceOptionsService', new TeamleaderInvoiceOptionsService(teamleaderClient));
  app.decorate('teamleaderInvoiceService', new TeamleaderInvoiceService(app.prisma, teamleaderClient));
});
