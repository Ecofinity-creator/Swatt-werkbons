import { z } from 'zod';

/** Lengte in bytes die TEAMLEADER_TOKEN_ENCRYPTION_KEY moet hebben na base64-decodering (AES-256). */
const TOKEN_ENCRYPTION_KEY_BYTES = 32;

/**
 * Alle environment variables lopen door dit ene, gevalideerde punt.
 * Faalt hard en meteen bij opstart als er iets ontbreekt/fout is — nooit
 * een silent `undefined` die pas diep in de request-flow een probleem geeft.
 */
const rawEnvSchema = z.object({
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

  /**
   * Teamleader OAuth2 (Phase 2 — zie modules/teamleader/). Alle vier bewust
   * optioneel: dit laat de rest van de app (login, RBAC, ...) gewoon blijven
   * werken/deployen vóór Steven de Teamleader-marketplace-app geregistreerd
   * heeft. Zolang ze niet gezet zijn, geven de /teamleader/*-routes een
   * duidelijke "niet geconfigureerd"-foutmelding i.p.v. de hele app te laten
   * crashen bij opstart (zie isTeamleaderConfigured()/getTeamleaderConfig()
   * hieronder). Wél: als één van de vier gezet is, moeten ze alle vier gezet
   * zijn (zie superRefine) — een halve configuratie is een configuratiefout.
   */
  TEAMLEADER_CLIENT_ID: z.string().min(1).optional(),
  TEAMLEADER_CLIENT_SECRET: z.string().min(1).optional(),
  /** Moet exact overeenkomen met de redirect-URI die bij de Teamleader-app geregistreerd staat. */
  TEAMLEADER_REDIRECT_URI: z.string().url('TEAMLEADER_REDIRECT_URI moet een geldige URL zijn').optional(),
  /** base64-encoded AES-256-sleutel — zie token-crypto.service.ts. Genereer met: openssl rand -base64 32 */
  TEAMLEADER_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  /**
   * E-mailverzending (wachtwoord vergeten + uitnodigingsmail bij aanmaak van
   * een nieuwe gebruiker) via Resend — zie modules/email/email.service.ts.
   * Bewust optioneel, zelfde filosofie als Teamleader hierboven: de rest van
   * de app blijft werken zolang deze niet gezet zijn, enkel het versturen
   * van een e-mail geeft dan een duidelijke "niet geconfigureerd"-fout i.p.v.
   * de hele app te laten crashen bij opstart. Moeten samen gezet worden
   * (zie superRefine).
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Bv. "SWATT <noreply@ecofinity.eu>", of tijdelijk "onboarding@resend.dev" (Resend-sandbox, levert enkel af aan je eigen Resend-accountmail). */
  EMAIL_FROM_ADDRESS: z.string().min(1).optional(),

  /**
   * Phase 9 — Redis voor de BullMQ-achtergrondwerker (sectie 15). Bewust een
   * default i.p.v. verplicht: dit houdt lokale dev/test zonder Redis werkend
   * voor alles wat geen sync triggert (queue.ts verbindt pas lazy, bij het
   * eerste effectieve gebruik — zie de toelichting daar). In productie wijst
   * dit naar de Render Key Value-instance uit render.yaml.
   */
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  /**
   * Demo-/testmodus (zie server.ts): laat de BullMQ-syncwerker meedraaien
   * in hetzelfde proces als de API, i.p.v. als aparte `swatt-sync-worker`-
   * service. Reden: Render's gratis plan ondersteunt geen Background Worker-
   * services — deze vlag laat toe om de echte Teamleader-sync te tonen zonder
   * meteen naar een betaald plan te moeten. Bewust géén productie-oplossing:
   * bij echt volume moet dit uit en draait de aparte (betaalde) worker-service.
   * Default `false` — bestaand gedrag blijft ongewijzigd tenzij expliciet aangezet.
   */
  RUN_SYNC_WORKER_INLINE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
});

const envSchema = rawEnvSchema.superRefine((value, ctx) => {
  const teamleaderFields = {
    TEAMLEADER_CLIENT_ID: value.TEAMLEADER_CLIENT_ID,
    TEAMLEADER_CLIENT_SECRET: value.TEAMLEADER_CLIENT_SECRET,
    TEAMLEADER_REDIRECT_URI: value.TEAMLEADER_REDIRECT_URI,
    TEAMLEADER_TOKEN_ENCRYPTION_KEY: value.TEAMLEADER_TOKEN_ENCRYPTION_KEY,
  };
  const setFieldNames = Object.entries(teamleaderFields)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .map(([fieldName]) => fieldName);

  if (setFieldNames.length > 0 && setFieldNames.length < Object.keys(teamleaderFields).length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'TEAMLEADER_CLIENT_ID, TEAMLEADER_CLIENT_SECRET, TEAMLEADER_REDIRECT_URI en TEAMLEADER_TOKEN_ENCRYPTION_KEY horen samen ingesteld te worden (of geen enkele van de vier).',
    });
  }

  if (value.TEAMLEADER_TOKEN_ENCRYPTION_KEY !== undefined) {
    let keyByteLength = -1;
    try {
      keyByteLength = Buffer.from(value.TEAMLEADER_TOKEN_ENCRYPTION_KEY, 'base64').length;
    } catch {
      keyByteLength = -1;
    }
    if (keyByteLength !== TOKEN_ENCRYPTION_KEY_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TEAMLEADER_TOKEN_ENCRYPTION_KEY'],
        message:
          'TEAMLEADER_TOKEN_ENCRYPTION_KEY moet base64-encoded zijn en exact 32 bytes (256 bit) voorstellen — genereer met: openssl rand -base64 32',
      });
    }
  }

  const emailFieldsSet = [value.RESEND_API_KEY, value.EMAIL_FROM_ADDRESS].filter(
    (fieldValue) => fieldValue !== undefined,
  ).length;
  if (emailFieldsSet === 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'RESEND_API_KEY en EMAIL_FROM_ADDRESS horen samen ingesteld te worden (of geen van beide).',
    });
  }
});

export type Env = z.infer<typeof rawEnvSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Ongeldige environment-configuratie:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment-configuratie ongeldig — zie details hierboven.');
  }
  return parsed.data as Env;
}

export const env = loadEnv();

export interface TeamleaderEnvConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** base64-encoded, nog niet gedecodeerd — zie token-crypto.service.ts. */
  tokenEncryptionKey: string;
}

/** true zodra alle vier TEAMLEADER_*-variabelen gezet zijn (zie superRefine hierboven — nooit "gedeeltelijk"). */
export function isTeamleaderConfigured(): boolean {
  return (
    env.TEAMLEADER_CLIENT_ID !== undefined &&
    env.TEAMLEADER_CLIENT_SECRET !== undefined &&
    env.TEAMLEADER_REDIRECT_URI !== undefined &&
    env.TEAMLEADER_TOKEN_ENCRYPTION_KEY !== undefined
  );
}

/** Werp altijd eerst `isTeamleaderConfigured()` op — deze gooit als de configuratie ontbreekt. */
export function getTeamleaderConfig(): TeamleaderEnvConfig {
  if (
    env.TEAMLEADER_CLIENT_ID === undefined ||
    env.TEAMLEADER_CLIENT_SECRET === undefined ||
    env.TEAMLEADER_REDIRECT_URI === undefined ||
    env.TEAMLEADER_TOKEN_ENCRYPTION_KEY === undefined
  ) {
    throw new Error(
      'getTeamleaderConfig() aangeroepen terwijl de Teamleader-integratie niet geconfigureerd is — roep eerst isTeamleaderConfigured() op.',
    );
  }
  return {
    clientId: env.TEAMLEADER_CLIENT_ID,
    clientSecret: env.TEAMLEADER_CLIENT_SECRET,
    redirectUri: env.TEAMLEADER_REDIRECT_URI,
    tokenEncryptionKey: env.TEAMLEADER_TOKEN_ENCRYPTION_KEY,
  };
}

export interface EmailEnvConfig {
  apiKey: string;
  fromAddress: string;
}

/** true zodra beide EMAIL_*-variabelen gezet zijn (zie superRefine hierboven — nooit "gedeeltelijk"). */
export function isEmailConfigured(): boolean {
  return env.RESEND_API_KEY !== undefined && env.EMAIL_FROM_ADDRESS !== undefined;
}

/** Werp altijd eerst `isEmailConfigured()` op — deze gooit als de configuratie ontbreekt. */
export function getEmailConfig(): EmailEnvConfig {
  if (env.RESEND_API_KEY === undefined || env.EMAIL_FROM_ADDRESS === undefined) {
    throw new Error('getEmailConfig() aangeroepen terwijl e-mailverzending niet geconfigureerd is — roep eerst isEmailConfigured() op.');
  }
  return { apiKey: env.RESEND_API_KEY, fromAddress: env.EMAIL_FROM_ADDRESS };
}
