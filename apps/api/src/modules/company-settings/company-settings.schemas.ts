import { z } from 'zod';

/**
 * Zelfde base64-validatiepatroon als work-order.schemas.ts (foto's/
 * handtekening) — hier lokaal gehouden i.p.v. geïmporteerd, om deze module
 * niet nodeloos te koppelen aan de work-orders-module (zelfde bewuste keuze
 * als PHOTO_CATEGORY_LABELS in work-order-pdf-document.ts).
 */
function base64ImageSchema(maxBytes: number) {
  return z
    .string()
    .min(1, 'Logo-afbeelding ontbreekt.')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Ongeldige logo-afbeeldingsdata.')
    .refine((value) => Math.ceil((value.length * 3) / 4) <= maxBytes, {
      message: `Logo is te groot (max ${Math.round(maxBytes / (1024 * 1024))}MB).`,
    });
}

/** Lege string (bv. een geleegd formulierveld) telt als "niet ingevuld" — wordt `null`. */
const optionalTextField = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    })
    .refine((value) => value === null || value.length <= max, { message: `Mag niet langer zijn dan ${max} tekens.` });

export const updateCompanySettingsBodySchema = z
  .object({
    companyName: z.string().trim().min(1, 'Bedrijfsnaam is verplicht.').max(200),
    addressLine: optionalTextField(300),
    vatNumber: optionalTextField(50),
    contactEmail: optionalTextField(200),
    contactPhone: optionalTextField(50),
    workOrderLegalText: z.string().trim().min(1).max(1000).optional(),
    logoMimeType: z.enum(['image/png', 'image/jpeg']).optional(),
    logoDataBase64: base64ImageSchema(3 * 1024 * 1024).optional(),
    removeLogo: z.boolean().optional(),
    /** Licentiebeperking (betaalplan) — `null` wist de limiet weer. */
    maxEmployees: z.number().int().positive().nullable().optional(),
    /** Phase 12, deel D (sectie 5) — tarief per km in eurocent. `null` schakelt de km-vergoeding uit. */
    kmRateCents: z.number().int().positive().nullable().optional(),
  })
  .refine((data) => !data.logoDataBase64 || !!data.logoMimeType, {
    message: 'logoMimeType is verplicht wanneer er een logo meegestuurd wordt.',
    path: ['logoMimeType'],
  });

// Bewust GEEN `export type ... = z.infer<...>` hier (zoals elders in de
// codebase, bv. work-order.schemas.ts) — die naam zou botsen met
// `UpdateCompanySettingsBody` uit @swatt/shared-types. De route gebruikt het
// resultaat van `.parse()` gewoon structureel (zie company-settings.routes.ts).
