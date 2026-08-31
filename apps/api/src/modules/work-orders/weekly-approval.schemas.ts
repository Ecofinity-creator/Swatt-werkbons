import { z } from 'zod';

export const pendingWeekQuerySchema = z.object({
  projectId: z.string().uuid(),
});

export const projectIdParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const weeklyApprovalIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Zelfde definitie als work-order.schemas.ts — bewust lokaal gedupliceerd, zelfde patroon als elders in deze codebase (kleine, pure schema-helpers per module i.p.v. cross-module imports). */
function base64ImageSchema(maxBytes: number) {
  return z
    .string()
    .min(1, 'Afbeelding ontbreekt.')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Ongeldige afbeeldingsdata.')
    .refine((value) => Math.ceil((value.length * 3) / 4) <= maxBytes, {
      message: `Afbeelding is te groot (max ${Math.round(maxBytes / (1024 * 1024))}MB).`,
    });
}

/** Zelfde velden als signWorkOrderBodySchema (work-order.schemas.ts) — bewust identiek, één werkbon-handtekening ziet er nooit anders uit dan een week-handtekening. */
export const signWeekBodySchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  signerFunction: z.string().trim().min(1).max(200).optional(),
  confirmed: z.literal(true),
  mimeType: z.literal('image/png'),
  signatureDataBase64: base64ImageSchema(2.8 * 1024 * 1024),
});
