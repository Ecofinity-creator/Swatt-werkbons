import { randomBytes } from 'node:crypto';
import type { TeamleaderStatusResponseBody } from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { requireRole } from '../rbac/rbac.middleware';
import { SESSION_COOKIE_NAME } from '../auth/session.service';

/** Kortlevende httpOnly cookie die het CSRF-`state` bewaart tussen /authorize en /callback. */
const STATE_COOKIE_NAME = 'swatt_tl_oauth_state';
const STATE_COOKIE_PATH = '/teamleader/oauth';
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10; // 10 minuten — ruim voldoende om Teamleader's toestemmingsscherm te doorlopen

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

  // Bewust een browser-navigatie (302-redirect), geen JSON-endpoint: de
  // frontend linkt hier rechtstreeks naartoe (<a href>), zodat de admin
  // effectief naar Teamleader's eigen toestemmingsscherm gestuurd wordt.
  app.get(
    '/teamleader/oauth/authorize',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (_request, reply) => {
      const state = randomBytes(32).toString('hex');
      reply.setCookie(STATE_COOKIE_NAME, state, {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: 'lax',
        path: STATE_COOKIE_PATH,
        maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
      });
      const authorizationUrl = app.teamleaderAuthService.buildAuthorizationUrl(state);
      reply.redirect(authorizationUrl);
    },
  );

  // Geen `app.authenticate` als preHandler: Teamleader stuurt de browser hier
  // via een gewone top-level GET-navigatie naartoe, en een verlopen sessie
  // (de admin was even weg op Teamleader's toestemmingsscherm) mag de
  // koppeling zelf niet laten mislukken — vandaar de zachte
  // `resolveOptionalAdminUserId` hieronder in plaats van een harde 401.
  app.get('/teamleader/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const expectedState = request.cookies[STATE_COOKIE_NAME];
    reply.clearCookie(STATE_COOKIE_NAME, { path: STATE_COOKIE_PATH });

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

    const connectedByUserId = await resolveOptionalAdminUserId(app, request);

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
}

/**
 * Niet-gooiende variant van `app.authenticate` + `requireRole('ADMIN')`,
 * enkel gebruikt om `connectedByUserId` te bepalen op de OAuth-callback.
 * Geeft `null` terug (nooit een fout) zodra er geen geldige, actieve
 * ADMIN-sessie is — de koppeling zelf mag hier nooit op stranden.
 */
async function resolveOptionalAdminUserId(
  app: FastifyInstance,
  request:
