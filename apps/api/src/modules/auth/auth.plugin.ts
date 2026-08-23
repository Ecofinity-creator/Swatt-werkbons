import type { AuthenticatedUser } from '@swatt/shared-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AuthErrors } from '../../errors';
import type { EmailService } from '../email/email.service';
import { ResendEmailService } from '../email/email.service';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SESSION_COOKIE_NAME, SessionService } from './session.service';

declare module 'fastify' {
  interface FastifyInstance {
    authService: AuthService;
    sessionService: SessionService;
    /** Uitnodigings-/wachtwoord-vergeten-tokens — zie password-reset.service.ts. */
    passwordResetService: PasswordResetService;
    /** Generieke e-mailverzending (Resend) — zie modules/email/email.service.ts. */
    emailService: EmailService;
    /** preHandler: vult request.currentUser of gooit een 401 (mensentaal). */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Gezet door de `authenticate`-preHandler; null zolang die niet liep of niet ingelogd is. */
    currentUser: AuthenticatedUser | null;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const sessionService = new SessionService(app.prisma);
  const authService = new AuthService(app.prisma, sessionService);
  const passwordResetService = new PasswordResetService(app.prisma);

  app.decorate('sessionService', sessionService);
  app.decorate('authService', authService);
  app.decorate('passwordResetService', passwordResetService);
  app.decorate('emailService', new ResendEmailService());
  app.decorateRequest('currentUser', null);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      throw AuthErrors.notAuthenticated();
    }

    const session = await sessionService.findValidSession(sessionId);
    if (!session) {
      throw AuthErrors.notAuthenticated();
    }

    const currentUser = await authService.getCurrentUser(session.userId);
    if (!currentUser || !currentUser.isActive) {
      throw AuthErrors.notAuthenticated();
    }

    request.currentUser = currentUser;
  });
});
