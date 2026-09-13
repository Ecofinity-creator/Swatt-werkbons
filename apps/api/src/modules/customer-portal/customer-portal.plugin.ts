import type { CustomerPortalIdentity } from '@swatt/shared-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { CustomerPortalErrors } from '../../errors';
import { CustomerPortalAuthService } from './customer-portal-auth.service';
import { CustomerPortalService } from './customer-portal.service';
import { CUSTOMER_PORTAL_SESSION_COOKIE_NAME, CustomerPortalSessionService } from './customer-portal-session.service';

declare module 'fastify' {
  interface FastifyInstance {
    customerPortalAuthService: CustomerPortalAuthService;
    customerPortalSessionService: CustomerPortalSessionService;
    customerPortalService: CustomerPortalService;
    /** preHandler: vult request.currentCustomer of gooit een 401 (mensentaal) — volledig los van app.authenticate (medewerkers), zie de toelichting bij CustomerSession in schema.prisma. */
    authenticateCustomer: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Gezet door de `authenticateCustomer`-preHandler; null zolang die niet liep of niet ingelogd is. */
    currentCustomer: CustomerPortalIdentity | null;
  }
}

export default fp(async function customerPortalPlugin(app: FastifyInstance) {
  const sessionService = new CustomerPortalSessionService(app.prisma);
  const authService = new CustomerPortalAuthService(app.prisma);
  const service = new CustomerPortalService(app.prisma);

  app.decorate('customerPortalSessionService', sessionService);
  app.decorate('customerPortalAuthService', authService);
  app.decorate('customerPortalService', service);
  app.decorateRequest('currentCustomer', null);

  app.decorate('authenticateCustomer', async (request: FastifyRequest) => {
    const sessionId = request.cookies[CUSTOMER_PORTAL_SESSION_COOKIE_NAME];
    if (!sessionId) {
      throw CustomerPortalErrors.notAuthenticated();
    }

    const session = await sessionService.findValidSession(sessionId);
    if (!session) {
      throw CustomerPortalErrors.notAuthenticated();
    }

    const customer = await app.prisma.customer.findUnique({
      where: { id: session.customerId },
      select: { id: true, name: true },
    });
    if (!customer) {
      throw CustomerPortalErrors.notAuthenticated();
    }

    request.currentCustomer = customer;
  });
});
