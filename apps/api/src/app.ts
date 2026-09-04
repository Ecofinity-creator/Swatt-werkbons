import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { ApiErrorBody } from '@swatt/shared-types';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './config/env';
import { ApiError } from './errors';
import authPlugin from './modules/auth/auth.plugin';
import authRoutes from './modules/auth/auth.routes';
import seedRoutes from './modules/admin/seed.routes';
import companySettingsRoutes from './modules/company-settings/company-settings.routes';
import customerRoutes from './modules/customers/customer.routes';
import auditLogRoutes from './modules/audit-log/audit-log.routes';
import hoursExportRoutes from './modules/hours-export/hours-export.routes';
import invoiceBatchRoutes from './modules/invoice-batches/invoice-batch.routes';
import payrollRoutes from './modules/payroll/payroll.routes';
import weeklyApprovalRoutes from './modules/work-orders/weekly-approval.routes';
import projectRoutes from './modules/projects/project.routes';
import teamleaderPlugin from './modules/teamleader/teamleader.plugin';
import teamleaderRoutes from './modules/teamleader/teamleader.routes';
import timeEntryRoutes from './modules/time-entries/time-entry.routes';
import userRoutes from './modules/users/user.routes';
import workOrderRoutes from './modules/work-orders/work-order.routes';
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

  // Render's edge/routing geeft (bevestigd via uitgebreid onderzoek — lokale
  // reproducties met identieke Fastify+@fastify/cors-configuratie werken
  // altijd correct) een kale, niet-JSON 404 terug op de CORS-preflight
  // (OPTIONS) voor onze routes, ook wanneer de dienst al wakker/warm is —
  // dus vóór onze eigen applicatiecode ooit bereikt wordt. In plaats van te
  // vertrouwen op een platform-detail buiten onze controle, vermijden we de
  // preflight structureel: een cross-origin request met `Content-Type:
  // text/plain` (i.p.v. `application/json`) is een CORS-"simple request" en
  // triggert nooit een preflight. De frontend (zie apps/web/src/api/client.ts)
  // stuurt daarom voortaan `text/plain`, met dezelfde JSON-payload — deze
  // parser zorgt dat die nog steeds als gewoon JSON binnenkomt.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
    if (typeof body !== 'string' || body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
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

    // Phase 6/7 — een te grote foto-/handtekening-upload (zie de per-route
    // `bodyLimit`-overrides in work-order.routes.ts). Fastify gooit dit zelf,
    // vóór onze route-handler of zod ooit bereikt wordt — vandaar sectie 27's
    // regel ("nooit kaal HTTP 422/413 tonen") hier expliciet afgevangen i.p.v.
    // via de generieke fallback hieronder.
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const body: ApiErrorBody = {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Deze upload is te groot. Maak een nieuwe foto met minder resolutie of kies een kleinere afbeelding.',
        },
      };
      reply.code(413).send(body);
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
  await app.register(teamleaderPlugin);
  await app.register(authRoutes);
  await app.register(seedRoutes);
  await app.register(teamleaderRoutes);
  await app.register(userRoutes);
  await app.register(projectRoutes);
  await app.register(timeEntryRoutes);
  await app.register(workOrderRoutes);
  await app.register(companySettingsRoutes);
  await app.register(customerRoutes);
  await app.register(invoiceBatchRoutes);
  await app.register(payrollRoutes);
  await app.register(weeklyApprovalRoutes);
  await app.register(hoursExportRoutes);
  await app.register(auditLogRoutes);

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
