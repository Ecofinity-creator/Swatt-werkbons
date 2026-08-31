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
  /** Licentiebeperking (betaalplan) — `null` = geen limiet. Zie schema.prisma voor de volledige toelichting. */
  maxEmployees: number | null;
  /** Phase 12, deel D (sectie 5) — tarief per km (eurocent), admin-only. `null` = km-vergoeding niet actief. */
  kmRateCents: number | null;
}

/** Patch voor `update()` — enkel de velden die de admin-instellingenpagina daadwerkelijk aanbiedt. */
export interface CompanySettingsUpdate {
  companyName: string;
  addressLine: string | null;
  vatNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  workOrderLegalText: string;
  maxEmployees: number | null;
  /** Phase 12, deel D (sectie 5) — `null` schakelt de km-vergoeding uit. */
  kmRateCents: number | null;
  /**
   * `undefined` = logo ongemoeid laten (geen nieuwe upload, geen verwijdering);
   * `null` = logo verwijderen; een string = de nieuwe StorageService-key.
   * Drie-waardig met opzet — anders is "niet meegegeven" niet te onderscheiden
   * van "expliciet verwijderen" zodra dit gewoon een `Partial<>`-veld was.
   */
  logoFileKey?: string | null;
}

/**
 * Bedrijfsgegevens voor de werkbon-PDF-header (secties 7/12 van de
 * projectbrief). Zelfde singleton-lazy-upsert-aanpak als TeamleaderConnection
 * (zie teamleader-auth.service.ts): geen aparte seed-migratie nodig, en de
 * allereerste PDF-generatie werkt meteen met verstandige placeholders.
 *
 * `update()` + het admin-instellingenscherm ("Bedrijfsgegevens") zijn de
 * kleine vervolgstap die hierboven ooit aangekondigd stond — sectie 7 vraagt
 * expliciet "Configureerbaar door administrator", en Steven had de logo/
 * adresgegevens nodig vóór de eerstvolgende live werkbon.
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

  async update(patch: CompanySettingsUpdate): Promise<CompanySettingsRecord> {
    const fields = {
      companyName: patch.companyName,
      addressLine: patch.addressLine,
      vatNumber: patch.vatNumber,
      contactEmail: patch.contactEmail,
      contactPhone: patch.contactPhone,
      workOrderLegalText: patch.workOrderLegalText,
      maxEmployees: patch.maxEmployees,
      kmRateCents: patch.kmRateCents,
      // Enkel meesturen wanneer expliciet gezet — `logoFileKey: undefined` zou
      // Prisma anders interpreteren als "dit veld niet wijzigen", wat hier
      // toevallig ook het gewenste gedrag is, maar dat willen we niet stilzwijgend
      // van Prisma's eigen semantiek laten afhangen (zie exactOptionalPropertyTypes
      // elders in deze codebase — bewust expliciet i.p.v. impliciet).
      ...(patch.logoFileKey !== undefined ? { logoFileKey: patch.logoFileKey } : {}),
    };
    return this.prisma.companySettings.upsert({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      update: fields,
      create: { id: COMPANY_SETTINGS_SINGLETON_ID, ...fields },
    });
  }
}
