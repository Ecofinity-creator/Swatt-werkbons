import type { PrismaClient } from '@prisma/client';
import { TeamleaderErrors } from '../../errors';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from './teamleader-auth.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

/**
 * Read-only sync van Teamleader-projecten (+ hun klant) naar de lokale cache
 * (Customer/Project — zie schema.prisma). Fase 3-slice van de roadmap.
 *
 * Alle veldnamen hieronder zijn geverifieerd tegen het officiële blueprint
 * (github.com/teamleadercrm/api/blob/master/apiary.apib, secties
 * `projects.list`, `projects-v2/projects.list`, `accounts.projects-v2-status`,
 * `contacts.info`, `companies.info`) — niet verzonnen.
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
    const seenTeamleaderIds: string[] = [];
    // Voorkomt herhaalde contacts.info/companies.info-calls voor dezelfde klant
    // binnen één sync-run (meerdere projecten delen vaak dezelfde klant).
    const customerCache = new Map<string, { id: string; address: string | null }>();

    for (const row of rows) {
      if (!row.customer) {
        skippedWithoutCustomerCount += 1;
        continue;
      }

      let customer: { id: string; address: string | null };
      try {
        customer = await this.ensureCustomer(row.customer, customerCache);
      } catch (err) {
        throw this.wrapTeamleaderError(err);
      }

      await this.prisma.project.upsert({
        where: { teamleaderId: row.id },
        create: {
          teamleaderId: row.id,
          teamleaderModule: module,
          customerId: customer.id,
          projectNumber: row.projectNumber,
          name: row.name,
          description: row.description,
          address: customer.address,
          status: row.status,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
        update: {
          teamleaderModule: module,
          customerId: customer.id,
          projectNumber: row.projectNumber,
          name: row.name,
          description: row.description,
          address: customer.address,
          status: row.status,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
      });
      seenTeamleaderIds.push(row.id);
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

  private async ensureCustomer(
    ref: TeamleaderCustomerRef,
    cache: Map<string, { id: string; address: string | null }>,
  ): Promise<{ id: string; address: string | null }> {
    const cacheKey = `${ref.type}:${ref.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const details =
      ref.type === 'company' ? await this.fetchCompanyDetails(ref.id) : await this.fetchContactDetails(ref.id);

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

    const result = { id: customer.id, address: customer.address };
    cache.set(cacheKey, result);
    return result;
  }

  private async fetchContactDetails(
    id: string,
  ): Promise<{ name: string; vatNumber: string | null; address: string | null }> {
    const response = await this.client.post<{ data: ContactInfoRow }>('contacts.info', { id });
    const contact = response.data;
    return {
      name: `${contact.first_name} ${contact.last_name}`.trim(),
      vatNumber: null,
      address: formatAddress(contact.primary_address),
    };
  }

  private async fetchCompanyDetails(
    id: string,
  ): Promise<{ name: string; vatNumber: string | null; address: string | null }> {
    const response = await this.client.post<{ data: CompanyInfoRow }>('companies.info', { id });
    const company = response.data;
    return {
      name: company.name,
      vatNumber: company.vat_number,
      address: formatAddress(company.primary_address),
    };
  }

  private wrapTeamleaderError(err: unknown): Error {
    if (err instanceof TeamleaderApiError) {
      return TeamleaderErrors.syncFailed(err.message);
    }
    return err instanceof Error ? TeamleaderErrors.syncFailed(err.message) : TeamleaderErrors.syncFailed('onbekende fout');
  }
}

function formatAddress(address: AddressResponse | null): string | null {
  if (!address) return null;
  const secondLine = [address.postal_code, address.city].filter((part) => part && part.length > 0).join(' ');
  const formatted = [address.line_1, secondLine].filter((part) => part && part.length > 0).join(', ');
  return formatted.length > 0 ? formatted : null;
}
