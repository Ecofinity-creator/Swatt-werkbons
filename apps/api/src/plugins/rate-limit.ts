import rateLimit from '@fastify/rate-limit';
import fastifyPlugin from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { RateLimitErrors } from '../errors';
import { getRedisConnection } from '../redis-connection';

/**
 * Fase 32 — klantvraag 15/9/2026: sectie 25 van de oorspronkelijke
 * projectbrief vroeg expliciet om "rate limiting", maar die was er nooit
 * gekomen (bevestigd tijdens een codebase-doorlichting op vraag van
 * Steven) — met name `/auth/login` had geen enkele drempel, dus een
 * aanvaller kon in theorie onbeperkt wachtwoorden proberen tegen een bekend
 * e-mailadres.
 *
 * Twee lagen:
 * 1. Een royale globale limiet over de hele API (misbruik-/DoS-drempel,
 *    hoog genoeg om een normale werksessie — timer, foto's, werkbon — nooit
 *    te raken).
 * 2. Veel strengere limieten specifiek op de drie ongeauthenticeerde
 *    auth-routes (`/auth/login`, `/auth/forgot-password`,
 *    `/auth/reset-password`) — brute-force-/account-enumeratie-/
 *    token-giswerk-bescherming — via de per-route `config.rateLimit`-optie
 *    in auth.routes.ts, die deze globale registratie per route overschrijft.
 *
 * Redis als store (i.p.v. de in-memory default van `@fastify/rate-limit`):
 * blijft zo correct werken over een herstart van de dienst heen, en
 * straks over meerdere gelijktijdige instanties — belangrijk net voor een
 * beveiligingsmaatregel, die anders bij elke deploy weer bij nul begint.
 *
 * `errorResponseBuilder` geeft een gewone `ApiError` (`RateLimitErrors.
 * tooManyRequests`) terug i.p.v. de kale default-foutbody van het plugin —
 * die vloeit via de bestaande globale `setErrorHandler` in app.ts naar
 * hetzelfde `{ error: { code, message } }`-formaat als elke andere fout
 * (sectie 27: nooit een kale technische foutmelding tonen). De
 * rate-limit-headers (`x-ratelimit-*`, `retry-after`) blijven ongewijzigd
 * staan — die zet het plugin zelf, vóór deze builder aangeroepen wordt.
 *
 * Volledig overgeslagen onder `NODE_ENV=test` (tenzij expliciet anders
 * opgegeven — zie `opts.enabled` hieronder; `@fastify/rate-limit` zelf kent
 * geen eigen "enabled"-optie, vandaar dat dit hier de registratie zelf
 * overslaat i.p.v. een niet-bestaande plugin-optie door te geven): de
 * bestaande integratietests roepen bv. `/auth/login` tientallen keren kort
 * na elkaar aan binnen hetzelfde testproces (altijd hetzelfde test-IP, geen
 * echte verschillende bezoekers) — zonder deze uitzondering zouden ze
 * onvermijdelijk tegen de limiet aanlopen en falen.
 * `rate-limit.plugin.integration.test.ts` test het effectieve gedrag (tegen
 * een echte Redis, vandaar "integration") apart, met deze plugin expliciet
 * `{ enabled: true }` doorgegeven.
 */
export interface RateLimitPluginOptions {
  /** Override voor `NODE_ENV=test`-gedrag — enkel bedoeld voor gebruik door de test hierboven. */
  enabled?: boolean;
  /**
   * Enkel voor gebruik door de test hierboven: een eigen Redis-key-prefix
   * per testrun, zodat opeenvolgende lokale testruns (dezelfde Redis, geen
   * verse container zoals in CI) elkaars tellers niet zien — een
   * Redis-backed limiter onthoudt zijn stand bewust over een herstart heen,
   * dat is precies het punt, maar dat betekent ook dat twee losse testruns
   * kort na elkaar anders dezelfde (nog niet verlopen) teller zouden delen.
   */
  nameSpace?: string;
}

export default fastifyPlugin(async function rateLimitPlugin(app: FastifyInstance, opts: RateLimitPluginOptions) {
  const enabled = opts.enabled ?? env.NODE_ENV !== 'test';
  if (!enabled) {
    return;
  }

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: getRedisConnection(),
    ...(opts.nameSpace !== undefined ? { nameSpace: opts.nameSpace } : {}),
    // Bij een (tijdelijke) Redis-storing de request gewoon doorlaten i.p.v.
    // de hele API plat te leggen — rate limiting is een beschermingslaag,
    // geen kernfunctionaliteit; sectie 9 van de ontwikkelregels ("externe
    // API-storing mag nooit lokale data verloren doen gaan") past hier
    // naar analogie ook op deze infrastructuurlaag.
    skipOnError: true,
    errorResponseBuilder: (_req, context) => {
      return RateLimitErrors.tooManyRequests(Math.ceil(context.ttl / 1000));
    },
  });
});
