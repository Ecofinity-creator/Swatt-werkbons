import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { ApiErrorBody } from '@swatt/shared-types';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './config/env';
import { ApiError } from './errors';
import authPlugin from './modules/auth/auth.plugin';
import authRoutes from './modules/auth/auth.routes';
import { requireRole } from './modules/rbac/rbac.middleware';
import prismaPlugin from './plugins/prisma';

export async function buildApp(): Promise<FastifyInstance> {
  // Nooit gevoelige velden (wachtwoorden, cookies) mee-loggen — `redact` is een
  // Pino-optie en hoort dus bínnen `logger`, niet als top-level Fastify-optie.
  const redact = ['req.headers.cookie', 'req.body.password'];

  const app = Fastify({
    // Onder `exactOptionalPropertyTypes` mag een optionele Fastify-optie nooit
    // expliciet op `undefined` gezet worden (dat is iets anders dan weglaten) —
    // vandaar drie volledig aparte object-literals i.p.v. één met een ternary op `transport`.
    logger:
      env.NODE_ENV === 'test'
        ? { level: 'silent', redact }
        : env.NODE_ENV === 'development'
          ? { level: 'info', redact, transport: { target: 'pino-pretty' } }
          : { level: 'info', redact },
  });

  // BELANGRIJK: setErrorHandler moet vóór app.register(...) van elke plugin/route
  // staan. Fastify's plugin-encapsulatie "bevriest" welke errorHandler een
  // child-context gebruikt op het moment dat die child-plugin boot (tijdens
  // `await app.register(...)`) — niet dynamisch bij elk request. Stond deze
  // handler hier ná de register()-calls (zoals eerder), dan hadden authPlugin/
  // authRoutes bij het booten nog Fastify's eigen default errorHandler te pakken
  // gekregen, en bleef ons `{ error: { code, message } }`-formaat onbereikbaar
  // voor fouten die daarbinnen gegooid worden — reproduceerbaar bevestigd met
  // een losstaand Fastify-testscript vóór deze fix.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      reply.code(error.statusCode).send(body);
      return;
    }

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'De ingevoerde gegevens zijn niet geldig. Controleer het formulier.',
        },
      };
      reply.code(400).send(body);
      return;
    }

    // Onverwachte fout: loggen met volledige details (server-side), maar
    // NOOIT interne details teruggeven aan de client (sectie 25/27 van de brief).
    request.log.error({ err: error }, 'Onverwachte fout');
    const body: ApiErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Er ging iets mis. Probeer het later opnieuw.',
      },
    };
    reply.code(500).send(body);
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  // Minimaal voorbeeld dat aantoont dat authenticate + requireRole end-to-end
  // samenwerken over een echte HTTP-route (zie test/auth.integration.test.ts).
  // Vanaf Phase 3+ vervangen echte admin-routes (bv. /admin/sync/projects) dit patroon.
  app.get(
    '/admin/ping',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async () => ({ pong: true }),
  );

  return app;
}
