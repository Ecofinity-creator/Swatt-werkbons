import type { AuthenticatedUser, UserRole } from '@swatt/shared-types';
import { roleAtLeast } from '@swatt/shared-types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthErrors } from '../../errors';

/**
 * Bewust een losse, puur-functionele module (geen Fastify-plugin) zodat dit
 * zonder een draaiende server/database unit-testbaar is — zie test/rbac.middleware.test.ts.
 *
 * Vereist dat `request.currentUser` al gezet is door de `authenticate`-preHandler
 * (zie auth.plugin.ts); die volgorde wordt afgedwongen door `requireRole` altijd
 * ná `{ preHandler: app.authenticate }` te registreren op de route.
 */
export function requireRole(minimumRole: UserRole) {
  return async function requireRoleHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const currentUser = request.currentUser;

    if (!currentUser) {
      throw AuthErrors.notAuthenticated();
    }

    if (!roleAtLeast(currentUser.role, minimumRole)) {
      throw AuthErrors.insufficientRole();
    }
  };
}

/** Kleine helper voor tests: bouwt een minimale FastifyRequest-achtige stub. */
export function stubRequest(currentUser: AuthenticatedUser | null): Pick<FastifyRequest, 'currentUser'> {
  return { currentUser };
}
