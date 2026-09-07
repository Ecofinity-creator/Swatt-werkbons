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

function createFakePrisma(opts: { existingAddress: string | null; existingKmDistanceOneWayMeters?: number | null }) {
  const projectRow = {
    id: 'proj-1',
    teamleaderId: 'tl-proj-1',
    address: opts.existingAddress,
    kmDistanceOneWayMeters: opts.existingKmDistanceOneWayMeters ?? (null as number | null),
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
      findMany: async () => [
        { teamleaderId: projectRow.teamleaderId, address: projectRow.address, kmDistanceOneWayMeters: projectRow.kmDistanceOneWayMeters },
      ],
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

  it('berekent NIET opnieuw wanneer het adres ongewijzigd is EN de afstand al eerder succesvol berekend werd (sectie 28 — geen onnodige externe calls)', async () => {
    const unchangedAddress = 'Kerkstraat 1, 2000 Antwerpen';
    const { prisma, projectRow } = createFakePrisma({ existingAddress: unchangedAddress, existingKmDistanceOneWayMeters: 12345 });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 99999) };
    const companySettingsService = { get: async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(distanceService.getDrivingDistanceMetersOneWay).not.toHaveBeenCalled();
    expect(projectRow.kmDistanceOneWayMeters).toBe(12345); // ongewijzigd gebleven, niet overschreven met de (niet-aangeroepen) nieuwe waarde
  });

  it('berekent WEL (opnieuw) wanneer het adres ongewijzigd is maar de afstand nog nooit succesvol berekend werd (bugfix 7/9/2026 — een project blijft anders voor altijd zonder km-vergoeding steken)', async () => {
    const unchangedAddress = 'Kerkstraat 1, 2000 Antwerpen';
    const { prisma, projectRow } = createFakePrisma({ existingAddress: unchangedAddress, existingKmDistanceOneWayMeters: null });
    const client = fakeClient(JANSSENS_ADDRESS);
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 12345) };
    const companySettingsService = { get: async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }) } as unknown as CompanySettingsService;

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(distanceService.getDrivingDistanceMetersOneWay).toHaveBeenCalledWith('Swatt-adres 1, 2000 Antwerpen', 'Kerkstraat 1, 2000 Antwerpen');
    expect(projectRow.kmDistanceOneWayMeters).toBe(12345);
  });

  it('haalt de bedrijfsinstellingen maar ÉÉN keer op, ongeacht hoeveel projecten tegelijk een km-herberekening nodig hebben (fix 7/9/2026 — HTTP 502 bij "Synchroniseer projecten" door onnodig herhaald werk)', async () => {
    const projectRows = [
      { id: 'proj-1', teamleaderId: 'tl-proj-1', address: 'Kerkstraat 1, 2000 Antwerpen', kmDistanceOneWayMeters: null as number | null },
      { id: 'proj-2', teamleaderId: 'tl-proj-2', address: 'Dorpsstraat 2, 3000 Leuven', kmDistanceOneWayMeters: null as number | null },
      { id: 'proj-3', teamleaderId: 'tl-proj-3', address: 'Marktplein 3, 9000 Gent', kmDistanceOneWayMeters: null as number | null },
    ];
    const customerRows = new Map(projectRows.map((p, i) => [`tl-comp-${i + 1}`, { id: `cust-${i + 1}`, address: p.address }]));

    const prisma = {
      teamleaderConnection: { findUnique: async () => ({ id: 'singleton', projectsModule: 'LEGACY' }) },
      customer: {
        upsert: async ({ where }: { where: { teamleaderId: string } }) => customerRows.get(where.teamleaderId)!,
      },
      project: {
        findMany: async () => projectRows.map((p) => ({ teamleaderId: p.teamleaderId, address: p.address, kmDistanceOneWayMeters: p.kmDistanceOneWayMeters })),
        upsert: async ({ where }: { where: { teamleaderId: string } }) => projectRows.find((p) => p.teamleaderId === where.teamleaderId)!,
        updateMany: async () => ({ count: 0 }),
        update: async ({ where, data }: { where: { teamleaderId: string }; data: { kmDistanceOneWayMeters: number } }) => {
          const row = projectRows.find((p) => p.teamleaderId === where.teamleaderId)!;
          row.kmDistanceOneWayMeters = data.kmDistanceOneWayMeters;
          return row;
        },
      },
    } as unknown as PrismaClient;

    const client = {
      listAll: async (endpoint: string) => {
        if (endpoint === 'projects.list') {
          return projectRows.map((p, i) => ({
            id: p.teamleaderId,
            reference: `PRO-${i + 1}`,
            title: `Project ${i + 1}`,
            description: null,
            status: 'active',
            customer: { type: 'company', id: `tl-comp-${i + 1}` },
          }));
        }
        if (endpoint === 'companies.list') {
          return projectRows.map((p, i) => ({
            id: `tl-comp-${i + 1}`,
            name: `Klant ${i + 1}`,
            vat_number: null,
            primary_address: { line_1: p.address!.split(',')[0], postal_code: p.address!.split(',')[1]?.trim().split(' ')[0], city: p.address!.split(',')[1]?.trim().split(' ')[1] },
          }));
        }
        if (endpoint === 'contacts.list') return [];
        throw new Error(`onverwacht endpoint in test: ${endpoint}`);
      },
    } as unknown as TeamleaderClient;

    const companySettingsGetSpy = vi.fn(async () => ({ addressLine: 'Swatt-adres 1, 2000 Antwerpen' }));
    const companySettingsService = { get: companySettingsGetSpy } as unknown as CompanySettingsService;
    const distanceService: DistanceService = { getDrivingDistanceMetersOneWay: vi.fn(async () => 5000) };

    const service = new ProjectSyncService(prisma, client, distanceService, companySettingsService);
    await service.syncAll();

    expect(companySettingsGetSpy).toHaveBeenCalledTimes(1);
    expect(distanceService.getDrivingDistanceMetersOneWay).toHaveBeenCalledTimes(3);
    expect(projectRows.every((p) => p.kmDistanceOneWayMeters === 5000)).toBe(true);
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
