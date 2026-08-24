import type { PrismaClient } from '@prisma/client';

/** Vast, welbekend ID — zelfde singleton-patroon als TEAMLEADER_CONNECTION_SINGLETON_ID (teamleader-auth.service.ts). */
export const COMPANY_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000002';

/** Sectie 12 — de door de brief zelf voorgestelde exacte standaardtekst. Via CompanySettings.workOrderLegalText aanpasbaar. */
const DEFAULT_LEGAL_TEXT =
  'De klant bevestigt door ondertekening de hierboven vermelde uitgevoerde werkzaamheden.';

export interface CompanySettingsRecord {
  id: string;
  companyName: string;
  addressLine: string | null;
  vatNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  logoFileKey: string | null;
  workOrderLegalText: string;
}

/**
 * Bedrijfsgegevens voor de werkbon-PDF-header (secties 7/12 van de
 * projectbrief). Zelfde singleton-lazy-upsert-aanpak als TeamleaderConnection
 * (zie teamleader-auth.service.ts): geen aparte seed-migratie nodig, en de
 * allereerste PDF-generatie werkt meteen met verstandige placeholders.
 *
 * Vandaag enkel een `get()` — bewust nog geen `update()`/admin-route deze
 * ronde (Phase 8 focust op PDF-generatie zelf); een klein instellingenscherm
 * om deze gegevens aan te passen is een voor de hand liggende, kleine
 * vervolgstap. Tot dan kunnen de waarden rechtstreeks in de database
 * aangepast worden.
 */
export class CompanySettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(): Promise<CompanySettingsRecord> {
    return this.prisma.companySettings.upsert({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      update: {},
      create: {
        id: COMPANY_SETTINGS_SINGLETON_ID,
        companyName: 'Jouw bedrijf',
        workOrderLegalText: DEFAULT_LEGAL_TEXT,
      },
    });
  }
}
