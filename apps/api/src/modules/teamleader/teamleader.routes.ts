import { randomBytes } from 'node:crypto';
import type {
  PrepareAuthorizeResponseBody,
  ProjectSyncResponseBody,
  TeamleaderStatusResponseBody,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { AuthErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';

/** Kortlevende httpOnly cookie die het CSRF-`state` bewaart tussen /authorize en /callback. */
const STATE_COOKIE_NAME = 'swatt_tl_oauth_state';
/** Kortlevende httpOnly cookie die onthoudt wélke admin de koppeling initieerde (zie AUTHORIZE_HANDOFF_TTL_MS hieronder). */
const CONNECTED_BY_COOKIE_NAME = 'swatt_tl_oauth_admin';
const STATE_COOKIE_PATH = '/teamleader/oauth';
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10; // 10 minuten — ruim voldoende om Teamleader's toestemmingsscherm te doorlopen

/**
 * Deze twee cookies worden gezet én gelezen binnen ÉÉN doorlopende
 * top-level-navigatiecontext op het Render-domein zelf (heen via de
 * /authorize-redirect, terug via Teamleader's eigen redirect naar
 * /callback) — dat raakt niet door het cross-site cookiepartitie-probleem
 * hieronder, dus `SameSite=None` volstaat hier prima (met `Secure` in productie).
 */
const OAUTH_COOKIE_SAME_SITE = env.COOKIE_SECURE ? 'none' : 'lax';

/**
 * BELANGRIJK — waarom dit bestaat:
 * "Verbind met Teamleader" is bewust een echte browsernavigatie (top-level),
 * geen fetch — Render moet met een 302 naar Teamleader's eigen
 * toestemmingsscherm kunnen doorsturen, en enkel een top-level navigatie
 * kan de browser daadwerkelijk volgen.
 *
 * Maar precies daardoor kan deze route zich NIET op de normale sessiecookie
 * (`swatt_session`) baseren om te controleren of de gebruiker een ingelogde
 * admin is: die cookie wordt gezet via een fetch()-call vanaf de frontend
 * (Vercel). Moderne browsers met cross-site cookiebescherming (bevestigd via
 * Firefox' "Total Cookie Protection" — Chrome/Edge volgen eenzelfde
 * richting) bewaren zo'n cookie in een aparte "partitie", gekoppeld aan
 * Vercel als topsite. Die partitie is niet zichtbaar zodra de browser
 * rechtstreeks (top-level) naar het Render-domein zelf navigeert.
 *
 * Oplossing: de frontend haalt eerst — via een gewone, wél
 * cookie-geauthenticeerde fetch-call (POST /teamleader/oauth/prepare-authorize)
 * — een kortlevend, eenmalig bruikbaar token op, en geeft dat token mee in
 * de navigatie-URL naar /teamleader/oauth/authorize. Enkel geldig voor
 * AUTHORIZE_HANDOFF_TTL_MS en één gebruik; in-memory (geen databasetabel
 * nodig voor iets dat binnen seconden verbruikt wordt, en dat bij een
 * herstart van de dienst probleemloos simpelweg opnieuw aangevraagd kan worden).
 */
const AUTHORIZE_HANDOFF_TTL_MS = 60_000;
const authorizeHandoffTokens = new Map<string, { userId: string; expiresAt: number }>();

function pruneExpiredHandoffTokens(): void {
  const now = Date.now();
  for (const [token, info] of authorizeHandoffTokens) {
    if (info.expiresAt < now) authorizeHandoffTokens.delete(token);
  }
}

export default async function teamleaderRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/teamleader/status',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (): Promise<TeamleaderStatusResponseBody> => {
      const status = await app.teamleaderAuthService.getStatus();
      return {
        status: status.status,
        connectedAt: status.connectedAt ? status.connectedAt.toISOString() : null,
        tokenExpiresAt: status.tokenExpiresAt ? status.tokenExpiresAt.toISOString() : null,
        lastError: status.lastError,
      };
    },
  );

  // Stap 1 van de koppeling: een normale, cookie-geauthenticeerde fetch-call
  // (zie de uitgebreide toelichting hierboven) die enkel een kortlevend
  // eenmalig token teruggeeft.
  app.post(
    '/teamleader/oauth/prepare-authorize',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<PrepareAuthorizeResponseBody> => {
      if (!request.currentUser) throw AuthErrors.notAuthenticated();
      pruneExpiredHandoffTokens();
      const token = randomBytes(32).toString('hex');
      authorizeHandoffTokens.set(token, {
        userId: request.currentUser.id,
        expiresAt: Date.now() + AUTHORIZE_HANDOFF_TTL_MS,
      });
      return { token };
    },
  );

  // Stap 2: de echte browsernavigatie, geauthenticeerd via dat token i.p.v.
  // de (op dit punt onbetrouwbare) sessiecookie.
  app.get('/teamleader/oauth/authorize', async (request, reply) => {
    const redirectBase = `${env.CORS_ORIGINS[0] ?? 'http://localhost:5173'}/instellingen/teamleader`;
    const query = request.query as { token?: string };
    pruneExpiredHandoffTokens();
    const handoff = query.token ? authorizeHandoffTokens.get(query.token) : undefined;

    if (!handoff) {
      reply.redirect(`${redirectBase}?teamleaderError=HANDOFF_EXPIRED`);
      return;
    }
    authorizeHandoffTokens.delete(query.token as string); // eenmalig bruikbaar

    const state = randomBytes(32).toString('hex');
    reply.setCookie(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: OAUTH_COOKIE_SAME_SITE,
      path: STATE_COOKIE_PATH,
      maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    });
    reply.setCookie(CONNECTED_BY_COOKIE_NAME, handoff.userId, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: OAUTH_COOKIE_SAME_SITE,
      path: STATE_COOKIE_PATH,
      maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    });
    const authorizationUrl = app.teamleaderAuthService.buildAuthorizationUrl(state);
    reply.redirect(authorizationUrl);
  });

  // Geen `app.authenticate` als preHandler: Teamleader stuurt de browser hier
  // via een gewone top-level GET-navigatie naartoe. Welke admin de koppeling
  // initieerde, weten we niet meer via de sessiecookie (zelfde reden als
  // hierboven) maar via CONNECTED_BY_COOKIE_NAME, gezet in stap 2 hierboven —
  // die cookie doorloopt dezelfde ononderbroken top-level-navigatiecontext
  // op het Render-domein en is dus wél betrouwbaar beschikbaar.
  app.get('/teamleader/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const expectedState = request.cookies[STATE_COOKIE_NAME];
    const connectedByUserId = request.cookies[CONNECTED_BY_COOKIE_NAME] ?? null;
    reply.clearCookie(STATE_COOKIE_NAME, {
      path: STATE_COOKIE_PATH,
      secure: env.COOKIE_SECURE,
      sameSite: OAUTH_COOKIE_SAME_SITE,
    });
    reply.clearCookie(CONNECTED_BY_COOKIE_NAME, {
      path: STATE_COOKIE_PATH,
      secure: env.COOKIE_SECURE,
      sameSite: OAUTH_COOKIE_SAME_SITE,
    });

    const redirectBase = `${env.CORS_ORIGINS[0] ?? 'http://localhost:5173'}/instellingen/teamleader`;

    if (query.error) {
      reply.redirect(`${redirectBase}?teamleaderError=DENIED`);
      return;
    }
    if (!query.state || !expectedState || query.state !== expectedState) {
      reply.redirect(`${redirectBase}?teamleaderError=STATE_MISMATCH`);
      return;
    }
    if (!query.code) {
      reply.redirect(`${redirectBase}?teamleaderError=MISSING_CODE`);
      return;
    }

    try {
      await app.teamleaderAuthService.handleAuthorizationCallback({
        code: query.code,
        connectedByUserId,
      });
      reply.redirect(`${redirectBase}?teamleaderConnected=1`);
    } catch (err) {
      request.log.error({ err }, 'Teamleader OAuth-callback mislukt');
      reply.redirect(`${redirectBase}?teamleaderError=EXCHANGE_FAILED`);
    }
  });

  app.post(
    '/teamleader/oauth/disconnect',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (_request, reply) => {
      await app.teamleaderAuthService.disconnect();
      reply.code(204);
      return null;
    },
  );

  // Bewust POST, geen GET: dit voert een actie uit (roept Teamleader aan,
  // schrijft naar onze eigen database) — geen idempotente resource-fetch.
  //
  // MVP-beperking: dit draait synchroon
