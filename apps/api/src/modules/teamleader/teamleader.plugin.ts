import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { getDistanceServiceApiKey, getDistanceServiceProvider, isDistanceServiceConfigured } from '../../config/env';
import { SyncJobService } from '../sync/sync-job.service';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { HereDistanceProvider, OpenRouteServiceDistanceProvider, type DistanceService } from '../distance/distance.service';
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
    /** Phase 12, deel D — geocodering/routeberekening voor de km-vergoeding (OpenRouteService), `null` zonder OPENROUTESERVICE_API_KEY. Ook decoreerd op app-niveau (niet enkel intern aan ProjectSyncService) zodat andere routes (bv. work-order.routes.ts) een ontbrekende afstand on-demand kunnen aanvullen, i.p.v. te moeten wachten tot de eerstvolgende bulk-"Synchroniseer projecten" die dit specifieke project toevallig bereikt. */
    distanceService: DistanceService | null;
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
  // OPENROUTESERVICE_API_KEY blijft de projectsync zelf gewoon werken, maar
  // dan wordt de km-vergoeding overal stil overgeslagen. Op vraag (7/9/2026,
  // na een lang debug-traject rond "km verschijnt nergens"): dit was vroeger
  // volledig onzichtbaar (geen enkele log-regel) — vandaar deze expliciete
  // waarschuwing bij opstart, zodat een vergeten omgevingsvariabele
  // voortaan meteen in de Render-logs zichtbaar is i.p.v. pas na een lang
  // "waarom werkt dit niet"-onderzoek.
  const distanceServiceConfigured = isDistanceServiceConfigured();
  if (!distanceServiceConfigured) {
    app.log.warn(
      'Noch HERE_API_KEY, noch OPENROUTESERVICE_API_KEY is ingesteld — de km-vergoeding (verplaatsingskosten) blijft daardoor overal uitgeschakeld, ook al staan een km-tarief en bedrijfsadres wél correct ingesteld in Bedrijfsgegevens.',
    );
  }
  // Op vraag (7/9/2026): HERE heeft voorrang op OpenRouteService (zie
  // getDistanceServiceProvider()) sinds een langdurige, externe storing bij
  // OpenRouteService — zie de toelichting bij HereDistanceProvider.
  const distanceServiceProvider = getDistanceServiceProvider();
  const distanceService: DistanceService | null = distanceServiceConfigured
    ? distanceServiceProvider === 'HERE'
      ? new HereDistanceProvider(getDistanceServiceApiKey())
      : new OpenRouteServiceDistanceProvider(getDistanceServiceApiKey())
    : null;
  if (distanceServiceConfigured) {
    app.log.info(`Km-vergoeding: actieve afstandsprovider is ${distanceServiceProvider}.`);
  }
  app.decorate('distanceService', distanceService);
  const companySettingsService = new CompanySettingsService(app.prisma);
  app.decorate('projectSyncService', new ProjectSyncService(app.prisma, teamleaderClient, distanceService, companySettingsService));
  app.decorate('teamleaderUserService', new TeamleaderUserService(teamleaderClient));
  app.decorate('milestoneSyncService', milestoneSyncService);
  app.decorate('syncJobService', new SyncJobService(app.prisma, timeTrackingSyncService, fileSyncService));
  app.decorate('teamleaderInvoiceOptionsService', new TeamleaderInvoiceOptionsService(teamleaderClient));
  app.decorate('teamleaderInvoiceService', new TeamleaderInvoiceService(app.prisma, teamleaderClient));
});
