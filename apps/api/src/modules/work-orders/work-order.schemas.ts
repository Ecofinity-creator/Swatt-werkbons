import { z } from 'zod';

export const workOrderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createWorkOrderBodySchema = z.object({
  projectId: z.string().uuid(),
  timeEntryIds: z.array(z.string().uuid()).min(1),
  description: z.string().trim().min(1).optional(),
});

export type CreateWorkOrderBody = z.infer<typeof createWorkOrderBodySchema>;

/**
 * Phase 6/7 — foto's en handtekening komen als base64 mee in de gewone JSON-
 * body (geen `multipart/form-data`) — zelfde reden als de rest van de app:
 * dit vermijdt een aparte Fastify-multipart-plugin en houdt de
 * `Content-Type: text/plain`-preflight-vermijding (zie apps/web/src/api/client.ts)
 * intact. De grove groottelimiet hieronder is een eerste, snelle afwijzing
 * vóór de dure base64-decode/opslag; de harde limiet is de per-route
 * `bodyLimit`-override in work-order.routes.ts (die vangt Fastify zelf af
 * met een nette 413-melding, zie app.ts).
 */
function base64ImageSchema(maxBytes: number) {
  return z
    .string()
    .min(1, 'Afbeelding ontbreekt.')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Ongeldige afbeeldingsdata.')
    .refine((value) => Math.ceil((value.length * 3) / 4) <= maxBytes, {
      message: `Afbeelding is te groot (max ${Math.round(maxBytes / (1024 * 1024))}MB).`,
    });
}

export const workOrderPhotoCategorySchema = z.enum([
  'SITUATIE_VOOR',
  'UITVOERING',
  'SITUATIE_NA',
  'SERIENUMMER',
  'TECHNISCHE_INSTALLATIE',
  'PROBLEEM_SCHADE',
  'OVERIGE',
]);

export const addWorkOrderPhotoBodySchema = z.object({
  category: workOrderPhotoCategorySchema.nullable().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  optimizedMimeType: z.literal('image/jpeg'),
  optimizedDataBase64: base64ImageSchema(7 * 1024 * 1024),
  thumbnailMimeType: z.literal('image/jpeg'),
  thumbnailDataBase64: base64ImageSchema(700 * 1024),
});

export type AddWorkOrderPhotoBody = z.infer<typeof addWorkOrderPhotoBodySchema>;

export const workOrderPhotoParamsSchema = z.object({
  id: z.string().uuid(),
  photoId: z.string().uuid(),
});

export const signWorkOrderBodySchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  signerFunction: z.string().trim().min(1).max(200).optional(),
  /** Sectie 10: "Ik bevestig dat bovenstaande werkzaamheden werden uitgevoerd." — verplicht aangevinkt. */
  confirmed: z.literal(true),
  mimeType: z.literal('image/png'),
  signatureDataBase64: base64ImageSchema(2.8 * 1024 * 1024),
});

export type SignWorkOrderBody = z.infer<typeof signWorkOrderBodySchema>;
