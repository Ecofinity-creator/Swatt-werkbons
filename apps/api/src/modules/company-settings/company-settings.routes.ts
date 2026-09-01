import type { CompanySettingsResponseBody, PublicBrandingResponseBody } from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { requireRole } from '../rbac/rbac.middleware';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import { CompanySettingsService } from './company-settings.service';
import { updateCompanySettingsBodySchema } from './company-settings.schemas';

// Ruim boven de ~4MB die de base64-limiet in company-settings.schemas.ts
// (3MB ruwe bytes → ~4MB base64) toelaat — zelfde reden als
// ADD_PHOTO_BODY_LIMIT in work-order.routes.ts: een geldige upload mag nooit
// op de HTTP-laag sneuvelen vóór zod's eigen mensentaal-foutmelding kan triggeren.
const UPDATE_BODY_LIMIT = 6 * 1024 * 1024;

/**
 * Admin-instellingenscherm "Bedrijfsgegevens" (secties 7/12 —
 * "Configureerbaar door administrator"). ADMIN-only, zelfde patroon als
 * /admin/teamleader/settings (teamleader.routes.ts).
 */
export default async function companySettingsRoutes(app: FastifyInstance): Promise<void> {
  const storage: StorageService = new DatabaseStorageService(app.prisma);
  const service = new CompanySettingsService(app.prisma);

  app.get(
    '/admin/company-settings',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (): Promise<CompanySettingsResponseBody> => {
      const settings = await service.get();
      return toResponseBody(storage, settings);
    },
  );

  app.post(
    '/admin/company-settings',
    { preHandler: [app.authenticate, requireRole('ADMIN')], bodyLimit: UPDATE_BODY_LIMIT },
    async (request): Promise<CompanySettingsResponseBody> => {      const body = updateCompanySettingsBodySchema.parse(request.body);
      const current = await service.get();

      // Logo-key bepalen vóór de update: nieuwe upload → opslaan en oude
      // (best-effort) verwijderen; expliciete verwijdering zonder nieuwe
      // upload → key op null; anders (geen van beide) → ongemoeid laten
      // (logoFileKey blijft `undefined`, zie CompanySettingsUpdate).
      let logoFileKey: string | null | undefined;
      if (body.logoDataBase64 && body.logoMimeType) {
        const buffer = Buffer.from(body.logoDataBase64, 'base64');
        logoFileKey = await storage.save(buffer, body.logoMimeType);
        if (current.logoFileKey) {
          await storage.delete(current.logoFileKey).catch(() => {
            // Best-effort — een falende opruiming van het oude logo mag de
            // nieuwe upload nooit blokkeren.
          });
        }
      } else if (body.removeLogo) {
        if (current.logoFileKey) {
          await storage.delete(current.logoFileKey).catch(() => {});
        }
        logoFileKey = null;
      }

      const updated = await service.update({
        companyName: body.companyName,
        addressLine: body.addressLine,
        vatNumber: body.vatNumber,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        workOrderLegalText: body.workOrderLegalText ?? current.workOrderLegalText,
        maxEmployees: body.maxEmployees !== undefined ? body.maxEmployees : current.maxEmployees,
        kmRateCents: body.kmRateCents !== undefined ? body.kmRateCents : current.kmRateCents,
        // `exactOptionalPropertyTypes` (zie CompanySettingsUpdate): enkel
        // meesturen wanneer effectief bepaald hierboven, anders zou een
        // letterlijke `logoFileKey: undefined` hier iets anders betekenen dan
        // het veld gewoon weglaten.
        ...(logoFileKey !== undefined ? { logoFileKey } : {}),
      });

      return toResponseBody(storage, updated);
    },
  );

  /**
   * Publieke, niet-geauthenticeerde route voor het loginscherm (sectie 21/33
   * — "app moet gepersonaliseerd aanvoelen"): geeft enkel bedrijfsnaam +
   * logo terug, nooit de rest van de instellingen (btw-nummer,
   * contactgegevens, km-tarief, max-medewerkers e.d. blijven ADMIN-only,
   * business rule 11-analoog — een niet-ingelogde bezoeker mag dit niet zien).
   */
  app.get('/public/branding', async (): Promise<PublicBrandingResponseBody> => {
    const settings = await service.get();
    let logoDataUrl: string | null = null;
    if (settings.logoFileKey) {
      try {
        const logo = await storage.read(settings.logoFileKey);
        logoDataUrl = `data:${logo.mimeType};base64,${logo.data.toString('base64')}`;
      } catch {
        logoDataUrl = null;
      }
    }
    return { companyName: settings.companyName, logoDataUrl };
  });
}

async function toResponseBody(storage: StorageService, settings: Awaited<ReturnType<CompanySettingsService['get']>>): Promise<CompanySettingsResponseBody> {
  let logoDataUrl: string | null = null;
  if (settings.logoFileKey) {
    try {
      const logo = await storage.read(settings.logoFileKey);
      logoDataUrl = `data:${logo.mimeType};base64,${logo.data.toString('base64')}`;
    } catch {
      // Verweesde key (bv. het opgeslagen bestand bestaat om een of andere
      // reden niet meer) — dan gewoon geen logo tonen i.p.v. de hele pagina
      // te laten falen.
      logoDataUrl = null;
    }
  }
  return {
    companyName: settings.companyName,
    addressLine: settings.addressLine,
    vatNumber: settings.vatNumber,
    contactEmail: settings.contactEmail,
    contactPhone: settings.contactPhone,
    workOrderLegalText: settings.workOrderLegalText,
    logoDataUrl,
    maxEmployees: settings.maxEmployees,
    kmRateCents: settings.kmRateCents,
  };
}
