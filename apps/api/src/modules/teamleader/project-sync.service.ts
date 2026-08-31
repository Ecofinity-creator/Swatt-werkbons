import type { PrismaClient } from '@prisma/client';
import { TeamleaderErrors } from '../../errors';
import type { CompanySettingsService } from '../company-settings/company-settings.service';
import type { DistanceService } from '../distance/distance.service';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from './teamleader-auth.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

/**
 * Read-only sync van Teamleader-projecten (+ hun klant) naar de lokale cache
 * (Customer/Project — zie schema.prisma). Fase 3-slice van de roadmap.
 *
 * Alle veldnamen hieronder zijn geverifieerd tegen het officiële blueprint
 * (github.com/teamleadercrm/api/blob/master/apiary.apib, secties
 * `projects.list`, `projects-v2/projects.list`, `accounts.projects-v2-status`,
 * `contacts.list`, `companies.list`) — niet verzonnen.
 *
 * BELANGRIJK — batch-opvraging i.p.v. één aanroep per klant:
 * eerdere versie deed één `contacts.info`/`companies.info`-aanroep per
 * distincte klant, wat bij een account met veel klanten realistisch tegen
 * Teamleader's eigen rate limit aanliep (200 aanvragen per rollend minuut —
 * zie sectie "Rate limiting" in het blueprint). Diezelfde sectie raadt
 * expliciet aan: "check if you can filter `.list` endpoints with a list of
 * entity `ids`". `contacts.list`/`companies.list` ondersteunen inderdaad
 * `filter.ids` en geven exact dezelfde velden terug als `contacts.info`/
 * `companies.info` (incl. `primary_address`) — dus we verzamelen eerst alle
 * distincte klant-id's over álle projecten heen, en halen ze daarna in
 * batches van hoogstens `DEFAULT_PAGE_SIZE` (20) per aanroep op, via de
 * bestaande `listAll()`-paginering. Dat brengt bijvoorbeeld 50 klanten terug
 * van 50 aanroepen naar 3.
 */

type TeamleaderProjectsModule = 'LEGACY' | 'PROJECTS_V2';

interface TeamleaderCustomerRef {
  type: 'contact' | 'company';
  id: string;
}

interface LegacyProjectRow {
  id: string;
  reference: string | null;
  title: string;
  description: string | null;
  status: 'active' | 'on_hold' | 'done' | 'cancelled';
  customer: TeamleaderCustomerRef | null;
}

interface ProjectsV2Row {
  id: string;
  project_key: number;
  title: string;
  description: string | null;
  status: 'open' | 'closed';
  customers: TeamleaderCustomerRef[];
}

interface NormalizedProjectRow {
  id: string;
  projectNumber: string | null;
  name: string;
  description: string | null;
  status: string;
  customer: TeamleaderCustomerRef | null;
}

interface AddressResponse {
  line_1: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
}

interface ContactInfoRow {
  id: string;
  first_name: string;
  last_name: string;
  primary_address: AddressResponse | null;
}

interface CompanyInfoRow {
  id: string;
  name: string;
  vat_number: string | null;
  primary_address: AddressResponse | null;
}

interface CustomerDetails {
  name: string;
  vatNumber: string | null;
  address: string | null;
}

export interface ProjectSyncResult {
  module: TeamleaderProjectsModule;
  syncedCount: number;
  /** Projecten zonder gekoppelde klant in Teamleader — bewust niet gesynchroniseerd, zie schema.prisma-toelichting. */
  skippedWithoutCustomerCount: number;
  archivedCount: number;
}

export class ProjectSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: TeamleaderClient,
    /**
     * Phase 12, deel D (sectie 5) — beide bewust optioneel: zonder
     * OPENROUTESERVICE_API_KEY (zie config/env.ts) blijft de projectsync
     * zelf gewoon werken, enkel de km-afstandsberekening slaat over
     * (Project.kmDistanceOneWayMeters blijft dan `null` i.p.v. de hele sync
     * te laten falen — business rule 9).
     */
    private readonly distanceService: DistanceService | null = null,
    private readonly companySettingsService: CompanySettingsService | null = null,
  ) {}

  async syncAll(): Promise<ProjectSyncResult> {
    const module = await this.resolveProjectsModule();

    let rows: NormalizedProjectRow[];
    try {
      rows = module === 'PROJECTS_V2' ? await this.fetchProjectsV2() : await this.fetchLegacyProjects();
    } catch (err) {
      throw this.wrapTeamleaderError(err);
    }

    let skippedWithoutCustomerCount = 0;
    const rowsWithCustomer: { row: NormalizedProjectRow; customer: TeamleaderCustomerRef }[] = [];
    for (const row of rows) {
      if (row.customer) {
        rowsWithCustomer.push({ row, customer: row.customer });
      } else {
        skippedWithoutCustomerCount += 1;
      }
    }

    let customerDetailsByKey: Map<string, CustomerDetails>;
    try {
      customerDetailsByKey = await this.fetchCustomerDetailsBatched(rowsWithCustomer.map((entry) => entry.customer));
    } catch (err) {
      throw this.wrapTeamleaderError(err);
    }

    // customer.teamleaderId -> onze lokale Customer.id (voorkomt herhaalde
    // upserts voor dezelfde klant binnen één sync-run — meerdere projecten
    // delen vaak dezelfde klant).
    const localCustomerCache = new Map<string, { id: string; address: string | null }>();
    const seenTeamleaderIds: string[] = [];

    // Phase 12, deel D — vooraf ophalen welk adres elk project al had, om na
    // de upsert te kunnen bepalen of het effectief gewijzigd is (en dus een
    // nieuwe km-berekening verdient) zonder dat voor elk project een aparte
    // extra round-trip nodig is.
    const previousAddressByTeamleaderId = new Map(
      (
        await this.prisma.project.findMany({
          where: { teamleaderId: { in: rowsWithCustomer.map((entry) => entry.row.id) } },
          select: { teamleaderId: true, address: true },
        })
      ).map((project: { teamleaderId: string; address: string | null }) => [project.teamleaderId, project.address]),
    );

    for (const { row, customer: ref } of rowsWithCustomer) {
      const cacheKey = `${ref.type}:${ref.id}`;
      const details = customerDetailsByKey.get(cacheKey);
      if (!details) {
        // Klant stond nog in het project, maar kon niet (meer) opgehaald worden
        // via contacts.list/companies.list (bv. intussen verwijderd in
        // Teamleader tussen het ophalen van de projectenlijst en dit moment).
        // Zelfde afhandeling als "geen klant gekoppeld": overslaan, niet laten
        // crashen (business rule 9 — externe API-eigenaardigheden mogen nooit
        // lokale data laten verloren gaan).
        skippedWithoutCustomerCount += 1;
        continue;
      }

      let localCustomer = localCustomerCache.get(cacheKey);
      if (!localCustomer) {
        const customer = await this.prisma.customer.upsert({
          where: { teamleaderId: ref.id },
          create: {
            teamleaderId: ref.id,
            teamleaderType: ref.type,
            name: details.name,
            address: details.address,
            vatNumber: details.vatNumber,
            isArchivedInTl: false,
            lastSyncedAt: new Date(),
          },
          update: {
            teamleaderType: ref.type,
            name: details.name,
            address: details.address,
            vatNumber: details.vatNumber,
            isArchivedInTl: false,
            lastSyncedAt: new Date(),
          },
        });
        localCustomer = { id: customer.id, address: customer.address };
        localCustomerCache.set(cacheKey, localCustomer);
      }

      await this.prisma.project.upsert({
        where: { teamleaderId: row.id },
        create: {
          teamleaderId: row.id,
          teamleaderModule: module,
          customerId: localCustomer.id,
          projectNumber: row.projectNumber,
          name: row.name,
          description: row.description,
          address: localCustomer.address,
          status: row.status,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
        update: {
          teamleaderModule: module,
          customerId: localCustomer.id,
          projectNumber: row.projectNumber,
          name: row.name,
          description: row.description,
          address: localCustomer.address,
          status: row.status,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
      });
      seenTeamleaderIds.push(row.id);

      // Phase 12, deel D — enkel herberekenen wanneer het adres effectief
      // gewijzigd is t.o.v. vóór deze upsert (of nog nooit berekend werd),
      // conform sectie 28 ("vraag nooit continu alle gegevens opnieuw op").
      // Bewust NA de upsert (project bestaat dan zeker) en in een eigen
      // try/catch: een mislukte km-berekening (netwerk, niet-geocodeerbaar
      // adres) mag de rest van de projectsync nooit blokkeren (business rule 9).
      if (localCustomer.address !== null && localCustomer.address !== previousAddressByTeamleaderId.get(row.id)) {
        await this.recomputeKmDistance(row.id, localCustomer.address);
      }
    }

    // Business rule 8: een project dat niet meer in Teamleader voorkomt wordt
    // gearchiveerd, nooit verwijderd — bestaande werkbon-historiek blijft intact.
    const archived = await this.prisma.project.updateMany({
      where: {
        teamleaderModule: module,
        isArchivedInTl: false,
        teamleaderId: { notIn: seenTeamleaderIds.length > 0 ? seenTeamleaderIds : ['__none_synced_this_run__'] },
      },
      data: { isArchivedInTl: true },
    });

    return {
      module,
      syncedCount: seenTeamleaderIds.length,
      skippedWithoutCustomerCount,
      archivedCount: archived.count,
    };
  }

  /**
   * Verzamelt alle distincte klant-id's uit `refs`, splitst ze op type
   * (contact/company — die twee lopen via afzonderlijke Teamleader-endpoints),
   * en haalt ze in batches op via `contacts.list`/`companies.list` met
   * `filter.ids` (zie de uitgebreide toelichting bovenaan dit bestand). Geeft
   * een map terug van `"type:id"` naar de opgehaalde gegevens; een id die
   * Teamleader niet (meer) teruggeeft, ontbreekt eenvoudigweg in de map.
   */
  private async fetchCustomerDetailsBatched(
    refs: TeamleaderCustomerRef[],
  ): Promise<Map<string, CustomerDetails>> {
    const contactIds = [...new Set(refs.filter((ref) => ref.type === 'contact').map((ref) => ref.id))];
    const companyIds = [...new Set(refs.filter((ref) => ref.type === 'company').map((ref) => ref.id))];

    const [contactRows, companyRows] = await Promise.all([
      contactIds.length > 0
        ? this.client.listAll<ContactInfoRow>('contacts.list', { filter: { ids: contactIds } })
        : Promise.resolve<ContactInfoRow[]>([]),
      companyIds.length > 0
        ? this.client.listAll<CompanyInfoRow>('companies.list', { filter: { ids: companyIds } })
        : Promise.resolve<CompanyInfoRow[]>([]),
    ]);

    const result = new Map<string, CustomerDetails>();
    for (const contact of contactRows) {
      result.set(`contact:${contact.id}`, {
        name: `${contact.first_name} ${contact.last_name}`.trim(),
        vatNumber: null,
        address: formatAddress(contact.primary_address),
      });
    }
    for (const company of companyRows) {
      result.set(`company:${company.id}`, {
        name: company.name,
        vatNumber: company.vat_number,
        address: formatAddress(company.primary_address),
      });
    }
    return result;
  }

  /**
   * Legacy en projects-v2 zijn onderling incompatibel — een account gebruikt
   * er exact één (bevestigd via support-artikel "New Teamleader Focus API
   * Project Endpoints"). We detecteren dit één keer via het officiële
   * `accounts.projects-v2-status`-endpoint en cachen het resultaat op de
   * TeamleaderConnection-rij, zodat niet elke sync-run opnieuw moet detecteren.
   */
  private async resolveProjectsModule(): Promise<TeamleaderProjectsModule> {
    const connection = await this.prisma.teamleaderConnection.findUnique({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
    });
    if (connection?.projectsModule) {
      return connection.projectsModule;
    }

    let response: { data: { status: 'projects-v2' | 'legacy' } };
    try {
      response = await this.client.post('accounts.projects-v2-status');
    } catch (err) {
      throw this.wrapTeamleaderError(err);
    }
    const module: TeamleaderProjectsModule = response.data.status === 'projects-v2' ? 'PROJECTS_V2' : 'LEGACY';

    await this.prisma.teamleaderConnection.update({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
      data: { projectsModule: module },
    });
    return module;
  }

  private async fetchProjectsV2(): Promise<NormalizedProjectRow[]> {
    const rows = await this.client.listAll<ProjectsV2Row>('projects-v2/projects.list');
    return rows.map((row) => ({
      id: row.id,
      projectNumber: String(row.project_key),
      name: row.title,
      description: row.description,
      status: row.status,
      // Bewuste vereenvoudiging: projects-v2 staat meerdere klanten per project
      // toe (`customers`-array); wij bewaren enkel de eerste — zie
      // schema.prisma-toelichting bij het Project-model.
      customer: row.customers[0] ?? null,
    }));
  }

  private async fetchLegacyProjects(): Promise<NormalizedProjectRow[]> {
    const rows = await this.client.listAll<LegacyProjectRow>('projects.list');
    return rows.map((row) => ({
      id: row.id,
      projectNumber: row.reference,
      name: row.title,
      description: row.description,
      status: row.status,
      customer: row.customer,
    }));
  }

  private wrapTeamleaderError(err: unknown): Error {
    if (err instanceof TeamleaderApiError) {
      return TeamleaderErrors.syncFailed(err.message);
    }
    return err instanceof Error ? TeamleaderErrors.syncFailed(err.message) : TeamleaderErrors.syncFailed('onbekende fout');
  }

  /**
   * Phase 12, deel D (sectie 5) — herberekent `Project.kmDistanceOneWayMeters`
   * tussen het Swatt-adres (CompanySettings.addressLine) en dit projectadres.
   * Faalt bewust stil (loggen, niet gooien): een niet-geocodeerbaar adres of
   * een tijdelijk onbereikbare OpenRouteService mag de rest van de
   * projectsync nooit blokkeren (business rule 9) — een volgende sync
   * (of een adreswijziging) probeert het gewoon opnieuw.
   */
  private async recomputeKmDistance(projectTeamleaderId: string, projectAddress: string): Promise<void> {
    if (!this.distanceService || !this.companySettingsService) return;

    try {
      const settings = await this.companySettingsService.get();
      if (!settings.addressLine) return; // Geen Swatt-adres ingesteld — niets om vanaf te berekenen.

      const meters = await this.distanceService.getDrivingDistanceMetersOneWay(settings.addressLine, projectAddress);
      await this.prisma.project.update({
        where: { teamleaderId: projectTeamleaderId },
        data: { kmDistanceOneWayMeters: meters },
      });
    } catch {
      // Bewust geen `console.error`/rethrow hier — deze service heeft geen
      // request-logger ter beschikking (geen Fastify-instantie), en een
      // mislukte km-berekening is nooit kritiek genoeg om de sync-run zelf
      // te laten falen. `Project.kmDistanceOneWayMeters` blijft dan gewoon
      // op zijn vorige waarde (of `null`) staan tot een latere, geslaagde poging.
    }
  }
}

function formatAddress(address: AddressResponse | null): string | null {
  if (!address) return null;
  const secondLine = [address.postal_code, address.city].filter((part) => part && part.length > 0).join(' ');
  const formatted = [address.line_1, secondLine].filter((part) => part && part.length > 0).join(', ');
  return formatted.length > 0 ? formatted : null;
}
