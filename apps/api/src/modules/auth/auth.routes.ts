import type { LoginResponseBody } from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { buildPasswordResetEmail } from './auth-emails';
import { forgotPasswordBodySchema, loginBodySchema, resetPasswordBodySchema } from './auth.schemas';
import { SESSION_COOKIE_NAME } from './session.service';

/**
 * Frontend (Vercel) en backend (Render) staan op verschillende domeinen —
 * elke fetch-call is voor de browser dus een "cross-site"-request. Een
 * cookie met `SameSite=Lax` wordt bij zo'n cross-site fetch/XHR NOOIT
 * meegestuurd (Lax staat dat enkel toe bij een top-level paginanavigatie
 * met een "veilige" methode, bv. het klikken op een link) — enkel
 * `SameSite=None` (verplicht in combinatie met `Secure`) laat de
 * sessiecookie betrouwbaar werken over twee verschillende domeinen, zowel
 * bij gewone API-calls als bij de Teamleader OAuth-navigatie. Lokaal (dev,
 * via de Vite-proxy) is frontend+backend wél hetzelfde origin en werkt
 * `Secure` niet over gewoon HTTP — vandaar de terugval op `Lax` wanneer
 * `COOKIE_SECURE` niet aan staat.
 */
const SESSION_COOKIE_SAME_SITE = env.COOKIE_SECURE ? 'none' : 'lax';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = loginBodySchema.parse(request.body);

    const { sessionId, user, expiresAt } = await app.authService.login(body.email, body.password, body.rememberMe);

    // `maxAge` rechtstreeks afgeleid van `expiresAt` (i.p.v. een aparte,
    // hardcoded duur) — zo kunnen cookie en server-side sessie (session.service.ts)
    // per definitie nooit uit elkaar lopen, ook niet wanneer "Onthou mij"
    // een andere duur oplevert (30 i.p.v. 7 dagen).
    const maxAge = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 1000));

    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: SESSION_COOKIE_SAME_SITE,
      path: '/',
      maxAge,
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
      reply.clearCookie(SESSION_COOKIE_NAME, {
        path: '/',
        secure: env.COOKIE_SECURE,
        sameSite: SESSION_COOKIE_SAME_SITE,
      });
      reply.code(204);
      return null;
    },
  );

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    return { user: request.currentUser };
  });

  app.post('/auth/forgot-password', async (request, reply) => {
    const body = forgotPasswordBodySchema.parse(request.body);

    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.isActive) {
      try {
        const token = await app.passwordResetService.createToken(user.id);
        await app.emailService.send(buildPasswordResetEmail(body.email, token));
      } catch (err) {
        // Nooit laten blijken aan de client of dit gelukt is (voorkomt
        // account-enumeratie via responsverschillen) — wel duidelijk loggen
        // server-side zodat een echte infrastructuurfout (bv.
        // EMAIL_NOT_CONFIGURED) niet onopgemerkt blijft.
        request.log.error({ err }, 'Versturen van wachtwoord-vergeten-e-mail mislukt');
      }
    }

    // Altijd hetzelfde antwoord, ongeacht of het e-mailadres bestaat/actief
    // is/de mail effectief verstuurd werd — zie AuthService.login voor
    // dezelfde anti-enumeratie-redenering.
    reply.code(204);
    return null;
  });

  app.post('/auth/reset-password', async (request, reply) => {
    const body = resetPasswordBodySchema.parse(request.body);
    await app.passwordResetService.consumeToken(body.token, body.password);
    reply.code(204);
    return null;
  });
}
