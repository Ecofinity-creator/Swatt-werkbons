import { z } from 'zod';

/**
 * Alle environment variables lopen door dit ene, gevalideerde punt.
 * Faalt hard en meteen bij opstart als er iets ontbreekt/fout is — nooit
 * een silent `undefined` die pas diep in de request-flow een probleem geeft.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is verplicht'),
  SESSION_COOKIE_SECRET: z
    .string()
    .min(32, 'SESSION_COOKIE_SECRET moet minstens 32 tekens zijn (cookie-signing key)'),
  /** Origins die de frontend (Vercel-deploy) mag hebben; komma-gescheiden. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim())),
  /** In productie via HTTPS (Vercel/Render) moet de sessiecookie 'secure' zijn. */
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Optioneel geheim voor de eenmalige `/admin/seed`-route (zie
   * modules/admin/seed.routes.ts): laat toe om, zonder command line of
   * directe databanktoegang, de allereerste ADMIN-gebruiker aan te maken via
   * de browser. Onopgezet (lokale dev) → route reageert altijd met 404.
   */
  SEED_TOKEN: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Ongeldige environment-configuratie:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment-configuratie ongeldig — zie details hierboven.');
  }
  return parsed.data;
}

export const env = loadEnv();
