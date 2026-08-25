import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { COMPANY_SETTINGS_SINGLETON_ID, CompanySettingsService } from '../src/modules/company-settings/company-settings.service';

/**
 * Unit-tests voor het admin-instellingenscherm "Bedrijfsgegevens" (secties
 * 7/12: "Configureerbaar door administrator") — met een fake-Prisma die
 * enkel `companySettings.upsert` nabootst, precies wat deze service gebruikt.
 */
function createFakePrisma() {
  let row: Record<string, unknown> | null = null;
  const prisma = {
    companySettings: {
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        row = row ? { ...row, ...update } : { ...create };
        return { ...row };
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, getRow: () => row };
}

describe('CompanySettingsService', () => {
  it('get() maakt bij de allereerste keer een rij aan met verstandige placeholders', async () => {
    const { prisma } = createFakePrisma();
    const service = new CompanySettingsService(prisma);

    const settings = await service.get();

    expect(settings.companyName).toBe('Jouw bedrijf');
    expect(settings.id).toBe(COMPANY_SETTINGS_SINGLETON_ID);
  });

  it('update() slaat de nieuwe bedrijfsgegevens op zonder het logo aan te raken wanneer logoFileKey niet meegegeven is', async () => {
    const { prisma, getRow } = createFakePrisma();
    const service = new CompanySettingsService(prisma);
    await service.get(); // eerste rij aanmaken, met logoFileKey nog niet gezet

    const updated = await service.update({
      companyName: 'Swatt',
      addressLine: 'Roeselaarsestraat 668 / 1, 8870 Izegem',
      vatNumber: 'BE0727.493.862',
      contactEmail: 'sales@swatt.be',
      contactPhone: '051 15 17 77',
      workOrderLegalText: 'De klant bevestigt door ondertekening de hierboven vermelde uitgevoerde werkzaamheden.',
      // logoFileKey bewust weggelaten
    });

    expect(updated.companyName).toBe('Swatt');
    expect(updated.vatNumber).toBe('BE0727.493.862');
    expect(getRow()?.logoFileKey).toBeUndefined(); // ongemoeid — nooit stilzwijgend op null gezet
  });

  it('update() verwijdert het logo wanneer logoFileKey expliciet op null gezet wordt', async () => {
    const { prisma, getRow } = createFakePrisma();
    const service = new CompanySettingsService(prisma);
    await service.update({
      companyName: 'Swatt',
      addressLine: null,
      vatNumber: null,
      contactEmail: null,
      contactPhone: null,
      workOrderLegalText: 'Tekst.',
      logoFileKey: 'storage-key-1',
    });
    expect(getRow()?.logoFileKey).toBe('storage-key-1');

    await service.update({
      companyName: 'Swatt',
      addressLine: null,
      vatNumber: null,
      contactEmail: null,
      contactPhone: null,
      workOrderLegalText: 'Tekst.',
      logoFileKey: null,
    });

    expect(getRow()?.logoFileKey).toBeNull();
  });
});
