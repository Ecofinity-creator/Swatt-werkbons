import type { LoginResponseBody } from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { loginBodySchema } from './auth.schemas';
import { SESSION_COOKIE_NAME } from './session.service';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = loginBodySchema.parse(request.body);

    const { sessionId, user } = await app.authService.login(body.email, body.password);

    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 dagen, moet in lijn blijven met SessionService
    });

    const responseBody: LoginResponseBody = { user };
    return responseBody;
  });

  app.post(
    '/auth/logout',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const sessionId = request.cookies[SESSION_COOKIE_NAME];
      if (sessionId) {
        await app.authService.logout(sessionId);
      }
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      reply.code(204);
      return null;
    },
  );

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    return { user: request.currentUser };
  });
}
