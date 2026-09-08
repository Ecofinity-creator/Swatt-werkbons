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

/** Op vraag (3/9/2026): "PDF via een knop naar de klant sturen" — geverifieerd via een erkende SDK-referentie (madeITBelgium/TeamLeader). */
interface EmailResponse {
  type: string;
  email: string;
}

interface ContactInfoRow {
  id: string;
  first_name: string;
  last_name: string;
  primary_address: AddressResponse | null;
  emails?: EmailResponse[];
}

interface CompanyInfoRow {
  id: string;
  name: string;
  vat_number: string | null;
  primary_address: AddressResponse | null;
  emails?: EmailResponse[];
}

interface CustomerDetails {
  name: string;
  vatNumber: string | null;
  address: string | null;
  email: string | null;
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
      // Op vraag (7/9/2026, diagnose, 2e helft): het opgehaalde adres voor
      // contactpersoon "Ruben Mazzier" bleek zelf volledig en correct
      // ({"line_1":"Hundelgemsesteenweg 737","postal_code":"9820","city":
      // "Merelbeke",...}) — het probleem moet dus in de koppeling tussen
      // PROJECT en klant-ID zitten, niet in de adresverwerking zelf. Log
      // daarom expliciet welke klant-referentie (type + Teamleader-ID) elk
      // project met "sanitair" in de naam heeft, om te vergelijken met het
      // bevestigde contact-ID van Ruben Mazzier.
      if (row.name.toLowerCase().includes('sanitair')) {
        // eslint-disable-next-line no-console
        console.log(`Km-diagnose: project "${row.name}" (${row.id}) heeft klant-referentie:`, JSON.stringify(row.customer));
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
    // Op vraag (7/9/2026) — zie de toelichting bij recomputeKmDistancesBounded() hieronder.
    const projectsNeedingKmRecompute: Array<{ projectTeamleaderId: string; projectName: string; projectAddress: string }> = [];
    const seenTeamleaderIds: string[] = [];

    // Phase 12, deel D — vooraf ophalen welk adres elk project al had, om na
    // de upsert te kunnen bepalen of het effectief gewijzigd is (en dus een
    // nieuwe km-berekening verdient) zonder dat voor elk project een aparte
    // extra round-trip nodig is. kmDistanceOneWayMeters wordt hier ook
    // meegenomen (op vraag, 7/9/2026): een project waarvan de afstand nooit
    // succesvol berekend werd (bv. de eerste poging faalde stil, of de
    // functie bestond nog niet toen dit project voor het eerst
    // gesynchroniseerd werd) mag niet voor altijd `null` blijven enkel omdat
    // het adres nadien niet meer wijzigt — "het adres is ongewijzigd"
    // betekent niet hetzelfde als "de afstand staat al correct".
    const previousStateByTeamleaderId = new Map<string, { address: string | null; kmDistanceOneWayMeters: number | null }>(
      (
        await this.prisma.project.findMany({
          where: { teamleaderId: { in: rowsWithCustomer.map((entry) => entry.row.id) } },
          select: { teamleaderId: true, address: true, kmDistanceOneWayMeters: true },
        })
      ).map((project: { teamleaderId: string; address: string | null; kmDistanceOneWayMeters: number | null }) => [
        project.teamleaderId,
        { address: project.address, kmDistanceOneWayMeters: project.kmDistanceOneWayMeters },
      ]),
    );

    for (const { row, customer: ref } of rowsWithCustomer) {
      const cacheKey = `${ref.type}:${ref.id}`;
      const details = customerDetailsByKey.get(cacheKey);
      if (row.name.toLowerCase().includes('sanitair')) {
        // eslint-disable-next-line no-console
        console.log(
          `Km-diagnose: project "${row.name}" zoekt cacheKey "${cacheKey}" op — ${details ? `GEVONDEN (${details.name})` : 'NIET GEVONDEN (dit project wordt overgeslagen als "geen klant gekoppeld")'}.`,
        );
      }
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
            email: details.email,
            vatNumber: details.vatNumber,
            isArchivedInTl: false,
            lastSyncedAt: new Date(),
          },
          update: {
            teamleaderType: ref.type,
            name: details.name,
            address: details.address,
            email: details.email,
            vatNumber: details.vatNumber,
            isArchivedInTl: false,
            lastSyncedAt: new Date(),
          },
        });
        localCustomer = { id: customer.id, address: customer.address };
        localCustomerCache.set(cacheKey, localCustomer);
      }

      // Op vraag (7/9/2026, diagnose, 4e ronde): bevestigd dat de matching
      // (cacheKey → contact) correct werkt en het opgehaalde adres correct
      // en volledig is — toch bleef "afstand = onbekend" na een sync.
      // Gericht op het bevestigde contact-ID van Ruben Mazzier zelf, om
      // precies te zien wat er ACHTERAF, na de upsert(s), effectief in de
      // databank terechtkomt.
      if (ref.id === '167eaca6-f41d-048c-bf75-b10ac48f8faa') {
        // eslint-disable-next-line no-console
        console.log(
          `Km-diagnose: na upsert voor project "${row.name}" (${row.id}) — details.address="${details.address}", localCustomer.address="${localCustomer.address}".`,
        );
      }

      const upsertedProject = await this.prisma.project.upsert({
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
      if (ref.id === '167eaca6-f41d-048c-bf75-b10ac48f8faa') {
        // eslint-disable-next-line no-console
        console.log(`Km-diagnose: project-upsert teruggegeven, opgeslagen address="${upsertedProject.address}" voor project ${upsertedProject.id}.`);
      }
      seenTeamleaderIds.push(row.id);

      // Phase 12, deel D — enkel herberekenen wanneer het adres effectief
      // gewijzigd is t.o.v. vóór deze upsert, OF de afstand nog nooit
      // succesvol berekend werd (kmDistanceOneWayMeters staat nog op
      // `null`) — conform sectie 28 ("vraag nooit continu alle gegevens
      // opnieuw op"), maar zonder een project blijvend zonder afstand te
      // laten zitten enkel omdat het adres toevallig ongewijzigd bleef.
      const previousState = previousStateByTeamleaderId.get(row.id);
      const addressChanged = localCustomer.address !== previousState?.address;
      const neverComputed = previousState?.kmDistanceOneWayMeters == null;
      if (localCustomer.address !== null && (addressChanged || neverComputed)) {
        projectsNeedingKmRecompute.push({ projectTeamleaderId: row.id, projectName: row.name, projectAddress: localCustomer.address });
      } else if (localCustomer.address === null && neverComputed) {
        // Op vraag (7/9/2026, 3e ronde van hetzelfde debug-traject): dit was
        // tot nu toe een derde, volledig stille faalmodus — een klant zonder
        // (volledig) adres in Teamleader (formatAddress() geeft dan `null`
        // terug) betekende dat deze project-rij hier simpelweg NOOIT in
        // projectsNeedingKmRecompute terechtkwam, dus ook nooit een
        // console.error uit recomputeKmDistance() kreeg — een km-vergoeding
        // die voor altijd `null` bleef, zonder dat ergens zichtbaar werd
        // waarom. Vandaar deze expliciete log hier, vóór dat punt.
        // eslint-disable-next-line no-console
        console.warn(
          `Km-afstand kan niet berekend worden voor project ${row.id} ("${row.name}"): de gekoppelde klant heeft geen (volledig) adres in Teamleader (straat/postcode/gemeente).`,
        );
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

    // Op vraag (7/9/2026, na een HTTP 502 bij "Synchroniseer projecten" —
    // met dank aan de ontdekking dat de Render-service op het gratis plan
    // draait en dus kan "in slapen" gaan bij inactiviteit): dit wordt bewust
    // WEL afgewacht binnen dezelfde HTTP-aanvraag. Een eerdere versie liet
    // dit als fire-and-forget-achtergrondtaak doorlopen ná de HTTP-respons,
    // maar dat is onbetrouwbaar op een gratis instance die kan stilvallen
    // vóór die taak klaar is. recomputeKmDistancesBounded() begrenst zelf
    // hoeveel projecten er per aanroep verwerkt worden (MAX_KM_RECOMPUTES_
    // PER_SYNC_RUN), zodat de totale wachttijd hier voorspelbaar kort
    // blijft, ook bij een grote initiële achterstand — zie de toelichting
    // daar voor het volledige verhaal.
    await this.recomputeKmDistancesBounded(projectsNeedingKmRecompute);

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

    // Op vraag (7/9/2026, diagnose): een contactpersoon met een zichtbaar
    // volledig adres in Teamleader ("Ruben Mazzier") kreeg toch geen
    // km-afstand — ondanks dat `primary_address` bevestigd het juiste
    // veldnamen zijn voor contacts.list/companies.list (Teamleader se eigen
    // apiary.apib). Tijdelijke, gerichte log van de RUWE respons om te zien
    // wat er precies binnenkomt, i.p.v. verder te gissen op basis van
    // documentatie alleen. Bewust enkel de velden die ertoe doen (geen
    // volledige contactgegevens in de logs).
    if (contactIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Km-diagnose: ruwe contacts.list-respons (${contactRows.length} van ${contactIds.length} opgevraagd):`,
        JSON.stringify(contactRows.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, primary_address: c.primary_address }))),
      );
    }

    const result = new Map<string, CustomerDetails>();
    for (const contact of contactRows) {
      result.set(`contact:${contact.id}`, {
        name: `${contact.first_name} ${contact.last_name}`.trim(),
        vatNumber: null,
        address: formatAddress(contact.primary_address),
        email: extractPrimaryEmail(contact.emails),
      });
    }
    for (const company of companyRows) {
      result.set(`company:${company.id}`, {
        name: company.name,
        vatNumber: company.vat_number,
        address: formatAddress(company.primary_address),
        email: extractPrimaryEmail(company.emails),
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
   * Op vraag (7/9/2026, na een HTTP 502 bij "Synchroniseer projecten"): de
   * eerdere bugfix ("herbereken ook wanneer nog nooit berekend") betekent
   * dat bij de allereerste sync met een correct ingestelde
   * OPENROUTESERVICE_API_KEY mogelijk TIENTALLEN projecten in één klap hun
   * afstand moeten laten berekenen. Elke berekening kost 2-3 externe
   * HTTP-aanroepen (geocoderen bedrijfsadres + geocoderen projectadres +
   * routeberekening).
   *
   * Deze methode verwerkt daarom hooguit MAX_PER_SYNC_RUN projecten per
   * aanroep, in begrensde parallelle batches, en wordt VOLLEDIG AWAIT binnen
   * dezelfde HTTP-aanvraag afgewerkt (zie syncAll() hieronder) — bewust GEEN
   * fire-and-forget-achtergrondtaak (een eerdere versie van deze fix deed
   * dat wel, maar bleek onbetrouwbaar op Render's gratis instance-tier: die
   * kan bij inactiviteit "in slaap" gaan, ook meteen ná het versturen van de
   * HTTP-respons — een taak die dan nog op de achtergrond zou moeten
   * doorlopen, kan zo halverwege afgebroken worden, zonder enige melding).
   * Bij een backlog groter dan MAX_PER_SYNC_RUN blijven de overige projecten
   * gewoon `null` staan tot een volgende klik op "Synchroniseer projecten"
   * — vandaar de expliciete log hieronder die dat aangeeft.
   *
   * Business rule 9 blijft gelden: één mislukte berekening (netwerk,
   * niet-geocodeerbaar adres) blokkeert de andere nooit en laat de rest van
   * de sync-run nooit falen.
   */
  private static readonly MAX_KM_RECOMPUTES_PER_SYNC_RUN = 15;

  private async recomputeKmDistancesBounded(
    allProjects: Array<{ projectTeamleaderId: string; projectName: string; projectAddress: string }>,
  ): Promise<void> {
    // Op vraag (7/9/2026, 5e ronde): "nog steeds geen km te zien", maar géén
    // enkele "Km-afstand"-logregel meer na een sync — dat kon tot nu toe
    // TWEE volledig verschillende dingen betekenen zonder onderscheid: ofwel
    // is er niets meer te berekenen (alles al klaar van een vorige, geslaagde
    // poging — GOED nieuws, dan is het probleem elders, bv. de PDF/het
    // ondertekenscherm zelf), ofwel ontbreekt de configuratie zelf
    // (distanceService/companySettingsService niet meegegeven). Vandaar nu
    // een expliciete log voor exact dit stille pad.
    if (allProjects.length === 0) {
      // eslint-disable-next-line no-console
      console.log('Km-afstand: geen enkel project had deze sync-run een herberekening nodig (alles staat al up-to-date).');
      return;
    }
    if (!this.distanceService || !this.companySettingsService) {
      // eslint-disable-next-line no-console
      console.warn(
        `Km-afstand kan niet berekend worden voor ${allProjects.length} project(en): OPENROUTESERVICE_API_KEY is niet geconfigureerd.`,
      );
      return;
    }

    const projects = allProjects.slice(0, ProjectSyncService.MAX_KM_RECOMPUTES_PER_SYNC_RUN);
    // Op vraag (7/9/2026, 4e ronde): "nog steeds geen km te zien", ondanks
    // een geslaagde sync zonder foutmelding — bleek uiteindelijk niet met
    // zekerheid vast te stellen te zijn, want een GESLAAGDE berekening werd
    // tot nu toe nergens gelogd (enkel mislukkingen/waarschuwingen). Bij een
    // backlog groter dan de portie van deze run kon een specifiek project
    // (bv. het testproject zelf) toevallig niet in de eerste 15 zitten,
    // zonder dat dat ergens zichtbaar was. Vandaar nu ook expliciet loggen
    // WELKE projecten deze run wél/niet aan bod komen, en het resultaat van
    // elke individuele berekening.
    if (allProjects.length > projects.length) {
      const skipped = allProjects.slice(ProjectSyncService.MAX_KM_RECOMPUTES_PER_SYNC_RUN);
      // eslint-disable-next-line no-console
      console.warn(
        `Km-afstand: ${allProjects.length} project(en) hebben een herberekening nodig, deze sync-run verwerkt er ${projects.length} (begrensd om binnen de requesttimeout te blijven). Klik nogmaals op "Synchroniseer projecten" om de rest bij te werken. Deze run overgeslagen: ${skipped.map((p) => p.projectName).join(', ')}.`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`Km-afstand: deze sync-run berekent voor: ${projects.map((p) => p.projectName).join(', ')}.`);

    const settings = await this.companySettingsService.get();
    if (!settings.addressLine) {
      // eslint-disable-next-line no-console
      console.warn(
        `Km-afstand kan niet berekend worden voor ${projects.length} project(en): er is geen bedrijfsadres ingesteld in Bedrijfsgegevens.`,
      );
      return;
    }
    const companyAddressLine = settings.addressLine;

    const CONCURRENCY = 5;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      const index = cursor;
      cursor += 1;
      if (index >= projects.length) return;
      const { projectTeamleaderId, projectName, projectAddress } = projects[index]!;
      await this.recomputeKmDistance(projectTeamleaderId, projectName, projectAddress, companyAddressLine);
      await runNext();
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, projects.length) }, () => runNext()));
  }

  private async recomputeKmDistance(projectTeamleaderId: string, projectName: string, projectAddress: string, companyAddressLine: string): Promise<void> {
    if (!this.distanceService) return;

    try {
      const meters = await this.distanceService.getDrivingDistanceMetersOneWay(companyAddressLine, projectAddress);
      await this.prisma.project.update({
        where: { teamleaderId: projectTeamleaderId },
        data: { kmDistanceOneWayMeters: meters },
      });
      // eslint-disable-next-line no-console
      console.log(`Km-afstand berekend voor project "${projectName}" (${projectTeamleaderId}): ${meters}m enkele rit.`);
    } catch (err) {
      // "Stil" betekent hier bewust NIET "onzichtbaar" (zie ook
      // teamleader.plugin.ts se opstartwaarschuwing bij een ontbrekende
      // OPENROUTESERVICE_API_KEY) — enkel de sync-run zelf mag er niet door
      // falen. Render vangt console.error automatisch op in zijn logstream.
      // eslint-disable-next-line no-console
      console.error(`Km-afstand herberekenen mislukt voor project "${projectName}" (${projectTeamleaderId}, adres "${projectAddress}"):`, err);
    }
  }
}

function formatAddress(address: AddressResponse | null): string | null {
  if (!address) return null;
  const secondLine = [address.postal_code, address.city].filter((part) => part && part.length > 0).join(' ');
  const formatted = [address.line_1, secondLine].filter((part) => part && part.length > 0).join(', ');
  return formatted.length > 0 ? formatted : null;
}

/** Voorkeur voor `type: "primary"`, anders gewoon de eerste — zelfde tolerante aanpak als formatAddress() hierboven. */
function extractPrimaryEmail(emails: EmailResponse[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((entry) => entry.type === 'primary');
  return (primary ?? emails[0])?.email ?? null;
}
