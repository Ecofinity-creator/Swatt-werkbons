import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSyncService } from '../src/modules/teamleader/project-sync.service';
import type { TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import type { DistanceService } from '../src/modules/distance/distance.service';
import type { CompanySettingsService } from '../src/modules/company-settings/company-settings.service';

/**
 * Phase 12, deel D — gericht op de km-afstandsberekening zelf (recomputeKmDistance()),
 * niet op de volledige ProjectSyncService-logica (die had voorheen geen eigen
 * testbestand — buiten scope om dat hier retroactief te bouwen). Minimale
 * fake-Prisma/-TeamleaderClient, enkel de velden/aanroepen die deze ene flow
 * (LEGACY-module, één company-klant, één project) effectief gebruikt.
 */

function createFakePrisma(opts: { existingAddress: string | null }) {
  const projectRow = {
    id: 'proj-1',
    teamleaderId: 'tl-proj-1',
    address: opts.existingAddress,
    kmDistanceOneWayMeters: null as number | null,
  };
  const customerRow = { id: 'cust-1', teamleaderId: 'tl-comp-1', address: null as string | null };

  const prisma = {
    teamleaderConnection: {
      findUnique: async () => ({ id: 'singleton', projectsModule: 'LEGACY' }),
    },
    customer: {
      upsert: async ({ create }: { create: { address: string | null } }) => {
        customerRow.address = create.address;
        return customerRow;
      },
    },
    project: {
      findMany: async () => [{ teamleaderId: projectRow.teamleaderId, address: projectRow.address }],
      upsert: async ({ update }: { update: { address: string | null } }) => {
        projectRow.address = update.address;
        return projectRow;
      },
      updateMany: async () => ({ count: 0 }),
      update: async ({ data }: { data: { kmDistanceOneWayMeters: number } }) => {
        projectRow.kmDistanceOneWayMeters = data.kmDistanceOneWayMeters;
        return projectRow;
      },
    },
  };

  return { prisma: prisma as unknown as PrismaClient, projectRow };
}

function fakeClient(companyAddress: { line_1: string; postal_code: string; city: string } | null): TeamleaderClient {
  return {
    listAll: async (endpoint: string) => {
      if (endpoint === 'projects.list') {
        return [{ id: 'tl-proj-1', reference: 'PRO-1', title: 'Onderhoud warmtepomp', description: null, status: 'active', customer: { type: 'company', id: 'tl-comp-1' } }];
      }
      if (endpoint === 'companies.list') {
        return [{ id: 'tl-comp-1', name: 'Janssens BV', vat_number: 'BE0123456789', primary_address: companyAddress }];
      }
      if (endpoint === 'contacts.list') return [];
      throw new Error(`onverwacht endpoint in test: ${endpoint}`);
    },
  } as unknown as TeamleaderClient;
}

const JANSSENS_ADDRESS = { line_1: 'Kerkstraat 1', postal_code: '2000', city: 'Antwerpen' };

describe('ProjectSyncService — Phase 12, deel D (km-afstand)', () => {
  it('berekent de afstand bij een nieuw/gewijzigd projectadres', async () => {
    const { prisma, projectRow } = createFakePrisma({ existingAddress: null });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 12345) };
    const companySettingsService = { get: async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(distanceService.getDrivingDistanceMetersOneWay).toHaveBeenCalledWith('Swatt-adres 1, 2000 Antwerpen', 'Kerkstraat 1, 2000 Antwerpen');
    expect(projectRow.kmDistanceOneWayMeters).toBe(12345);
  });

  it('berekent NIET opnieuw wanneer het adres ongewijzigd is (sectie 28 — geen onnodige externe calls)', async () => {
    const unchangedAddress = 'Kerkstraat 1, 2000 Antwerpen';
    const { prisma, projectRow } = createFakePrisma({ existingAddress: unchangedAddress });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 12345) };
    const companySettingsService = { get: async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(distanceService.getDrivingDistanceMetersOneWay).not.toHaveBeenCalled();
    expect(projectRow.kmDistanceOneWayMeters).toBeNull();
  });

  it('een mislukte km-berekening blokkeert de rest van de projectsync niet (business rule 9)', async () => {
    const { prisma, projectRow } = createFakePrisma({ existingAddress: null });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = {
      getDrivingDistanceMetersOneWay: vi.fn(async () => {
        throw new Error('OpenRouteService niet bereikbaar');
      }),
    };
    const companySettingsService = { get: async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    const result = await service.syncAll(); // gooit niet, ondanks de mislukte km-berekening

    expect(result.syncedCount).toBe(1);
    expect(projectRow.kmDistanceOneWayMeters).toBeNull(); // bleef ongewijzigd, geen halve/foute waarde
  });

  it('slaat de km-berekening over zonder ingesteld Swatt-adres', async () => {
    const { prisma, projectRow } = createFakePrisma({ existingAddress: null });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 12345) };
    const companySettingsService = { get: async () => ({ addressLine: null }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(distanceService.getDrivingDistanceMetersOneWay).not.toHaveBeenCalled();
    expect(projectRow.kmDistanceOneWayMeters).toBeNull();
  });

  it('zonder DistanceService (OPENROUTESERVICE_API_KEY niet geconfigureerd) blijft de sync gewoon werken', async () => {
    const { prisma, projectRow } = createFakePrisma({ existingAddress: null });
    const client = fakeClient(JANSSENS_ADDRESS);

    const service = new ProjectSyncService(prisma, client); // geen distanceService/companySettingsService meegegeven
    const result = await service.syncAll();

    expect(result.syncedCount).toBe(1);
    expect(projectRow.kmDistanceOneWayMeters).toBeNull();
  });
});
