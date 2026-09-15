import type {
  CustomerPortalMeResponseBody,
  ListCustomerPortalWorkOrdersResponseBody,
  VerifyCustomerPortalLinkResponseBody,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { CustomerPortalErrors } from '../../errors';
import { isEmailConfigured } from '../../config/env';
import { AuditLogService } from '../audit-log/audit-log.service';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import { buildCustomerPortalLoginEmail } from './customer-portal-emails';
import { CUSTOMER_PORTAL_SESSION_COOKIE_NAME } from './customer-portal-session.service';
import {
  customerPortalWorkOrderIdParamsSchema,
  requestCustomerPortalLinkBodySchema,
  verifyCustomerPortalLinkQuerySchema,
} from './customer-portal.schemas';

/** Zelfde SameSite-redenering als auth.routes.ts (Vercel/Render zijn verschillende domeinen — zie de uitgebreide toelichting daar). */
const CUSTOMER_PORTAL_COOKIE_SAME_SITE = env.COOKIE_SECURE ? 'none' : 'lax';
const CUSTOMER_PORTAL_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 dagen, zie CustomerPortalSessionService

/**
 * Fase 32 (klantvraag 15/9/2026 — rate limiting): zelfde risicoklasse als
 * /auth/forgot-password (mail-bombing/enumeratie) resp. /auth/reset-password
 * (token-giswerk) — zie de toelichting in auth.routes.ts.
 */
const REQUEST_LINK_RATE_LIMIT = { max: 5, timeWindow: '15 minutes' };
const VERIFY_LINK_RATE_LIMIT = { max: 8, timeWindow: '15 minutes' };

/**
 * Klantportaal (sectie 30, 13/9/2026): "eindklant logt in om eigen
 * werkbonnen/status te volgen". Magic-link-login, geen wachtwoord — zelfde
 * anti-enumeratie-filosofie als /auth/forgot-password (altijd hetzelfde
 * antwoord, ongeacht of het e-mailadres een klant is).
 */
export default async function customerPortalRoutes(app: FastifyInstance): Promise<void> {
  const storage: StorageService = new DatabaseStorageService(app.prisma);
  const auditLogService = new AuditLogService(app.prisma);

  app.post('/portal/auth/request-link', { config: { rateLimit: REQUEST_LINK_RATE_LIMIT } }, async (request, reply) => {
    const body = requestCustomerPortalLinkBodySchema.parse(request.body);

    const customer = await app.customerPortalAuthService.findCustomerByEmail(body.email);
    if (customer && isEmailConfigured()) {
      try {
        const token = await app.customerPortalAuthService.createLoginToken(customer.id);
        await app.emailService.send(buildCustomerPortalLoginEmail(body.email, token));
      } catch (err) {
        // Nooit laten blijken aan de client of dit gelukt is (zelfde redenering als /auth/forgot-password).
        request.log.error({ err }, 'Versturen van klantportaal-inloglink mislukt');
      }
    }

    reply.code(204);
    return null;
  });

  app.get('/portal/auth/verify', { config: { rateLimit: VERIFY_LINK_RATE_LIMIT } }, async (request, reply): Promise<VerifyCustomerPortalLinkResponseBody> => {
    const query = verifyCustomerPortalLinkQuerySchema.parse(request.query);
    const customer = await app.customerPortalAuthService.consumeLoginToken(query.token);
    const session = await app.customerPortalSessionService.createSession(customer.id);

    reply.setCookie(CUSTOMER_PORTAL_SESSION_COOKIE_NAME, session.sessionId, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: CUSTOMER_PORTAL_COOKIE_SAME_SITE,
      path: '/',
      maxAge: CUSTOMER_PORTAL_SESSION_MAX_AGE_SECONDS,
    });

    await auditLogService.record({
      actorUserId: null,
      action: 'CUSTOMER_PORTAL_LOGIN',
      entityType: 'Customer',
      entityId: customer.id,
      metadata: { customerName: customer.name },
    });

    return { customer };
  });

  app.post('/portal/auth/logout', { preHandler: [app.authenticateCustomer] }, async (request, reply) => {
    const sessionId = request.cookies[CUSTOMER_PORTAL_SESSION_COOKIE_NAME];
    if (sessionId) {
      await app.customerPortalSessionService.deleteSession(sessionId);
    }
    reply.clearCookie(CUSTOMER_PORTAL_SESSION_COOKIE_NAME, {
      path: '/',
      secure: env.COOKIE_SECURE,
      sameSite: CUSTOMER_PORTAL_COOKIE_SAME_SITE,
    });
    reply.code(204);
    return null;
  });

  app.get('/portal/me', { preHandler: [app.authenticateCustomer] }, async (request): Promise<CustomerPortalMeResponseBody> => {
    return { customer: request.currentCustomer! };
  });

  app.get(
    '/portal/work-orders',
    { preHandler: [app.authenticateCustomer] },
    async (request): Promise<ListCustomerPortalWorkOrdersResponseBody> => {
      const workOrders = await app.customerPortalService.listWorkOrders(request.currentCustomer!.id);
      return { workOrders };
    },
  );

  app.get('/portal/work-orders/:id/pdf', { preHandler: [app.authenticateCustomer] }, async (request, reply) => {
    const params = customerPortalWorkOrderIdParamsSchema.parse(request.params);
    const workOrder = await app.customerPortalService.getOwnedWorkOrder(request.currentCustomer!.id, params.id);

    if (workOrder.pdfStatus !== 'PDF_READY' || !workOrder.pdfFileKey) {
      throw CustomerPortalErrors.pdfNotReady();
    }

    const file = await storage.read(workOrder.pdfFileKey);
    reply.header('Content-Type', file.mimeType);
    reply.header('Content-Disposition', `inline; filename="${workOrder.pdfFileName ?? 'werkbon.pdf'}"`);
    return reply.send(file.data);
  });
}
