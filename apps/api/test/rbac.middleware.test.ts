import type { AuthenticatedUser } from '@swatt/shared-types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { requireRole, stubRequest } from '../src/modules/rbac/rbac.middleware';

function userWithRole(role: AuthenticatedUser['role']): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'test@swatt.be',
    role,
    isActive: true,
    employee: null,
  };
}

const noopReply = {} as FastifyReply;

describe('requireRole (business rule: RBAC per rol)', () => {
  it('laat een ADMIN toe op een route die minstens EMPLOYEE vereist', async () => {
    const request = stubRequest(userWithRole('ADMIN')) as FastifyRequest;
    await expect(requireRole('EMPLOYEE')(request, noopReply)).resolves.toBeUndefined();
  });

  it('laat een SUPERVISOR toe op een route die minstens SUPERVISOR vereist', async () => {
    const request = stubRequest(userWithRole('SUPERVISOR')) as FastifyRequest;
    await expect(requireRole('SUPERVISOR')(request, noopReply)).resolves.toBeUndefined();
  });

  it('weigert een EMPLOYEE op een route die minstens SUPERVISOR vereist', async () => {
    const request = stubRequest(userWithRole('EMPLOYEE')) as FastifyRequest;
    await expect(requireRole('SUPERVISOR')(request, noopReply)).rejects.toMatchObject(
      new ApiError(403, 'INSUFFICIENT_ROLE', 'Je hebt geen rechten voor deze actie.'),
    );
  });

  it('weigert een EMPLOYEE op een route die ADMIN vereist', async () => {
    const request = stubRequest(userWithRole('EMPLOYEE')) as FastifyRequest;
    await expect(requireRole('ADMIN')(request, noopReply)).rejects.toThrow(
      'Je hebt geen rechten voor deze actie.',
    );
  });

  it('weigert een niet-ingelogde requester (currentUser = null) met een duidelijke fout', async () => {
    const request = stubRequest(null) as FastifyRequest;
    await expect(requireRole('EMPLOYEE')(request, noopReply)).rejects.toMatchObject(
      new ApiError(401, 'NOT_AUTHENTICATED', 'Je bent niet (meer) ingelogd. Log opnieuw in.'),
    );
  });
});
