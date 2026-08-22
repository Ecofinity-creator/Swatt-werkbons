import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { ApiError } from '../../errors';
import { hashPassword } from '../auth/password.service';

/**
 * Eenmalige, browser-only setup-route om de allereerste ADMIN-gebruiker aan
 * te maken — nodig omdat de MVP bewust geen registratiescherm heeft (nieuwe
 * werknemers worden altijd door een beheerder aangemaakt), maar er bij een
 * verse deploy nog *geen enkele* gebruiker bestaat om mee in te loggen.
 *
 * Beveiliging:
 * - Vereist een geheim `token` query-param dat exact moet overeenkomen met
 *   SEED_TOKEN (op Render automatisch gegenereerd, enkel zichtbaar in het
 *   Render-dashboard). Zonder SEED_TOKEN in de omgeving reageert de route
 *   altijd met 404 — bv. lokale ontwikkeling.
 * - Werkt maar één keer: zodra er ergens al een gebruiker bestaat, weigert
 *   zowel GET als POST verder te werken. Dit is dus veilig om permanent
 *   gedeployed te laten staan; er is geen aparte "opruim"-stap nodig.
 * - Wachtwoord gaat nooit via de URL/query string (dat zou in server- en
 *   proxy-logs kunnen belanden) — het formulier op de GET-pagina verstuurt
 *   via JavaScript een JSON POST-body, net als de rest van de API.
 */

const seedBodySchema = z.object({
  displayName: z.string().min(1, 'Naam is verplicht'),
  email: z.string().email('Ongeldig e-mailadres'),
  password: z.string().min(8, 'Wachtwoord moet minstens 8 tekens zijn'),
});

function assertValidToken(request: FastifyRequest): void {
  const token = (request.query as { token?: string }).token;
  if (!env.SEED_TOKEN || !token || token !== env.SEED_TOKEN) {
    // Bewust dezelfde 404 in beide gevallen (geen token ingesteld vs. fout
    // token) — geeft een aanvaller geen enkel signaal of deze route "echt"
    // bestaat.
    throw new ApiError(404, 'NOT_FOUND', 'Niet gevonden.');
  }
}

function renderPage(body: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swatt Werkbon-app — eerste beheerder</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #f5f5f5;
           max-width: 28rem; margin: 4rem auto; padding: 0 1.5rem; }
    h1 { font-size: 1.25rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box;
            background: #1a1a1a; border: 1px solid #333; color: #f5f5f5; border-radius: 4px; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; background: #f0b90b; color: #0a0a0a;
             border: none; border-radius: 4px; font-weight: 600; cursor: pointer; }
    #msg { margin-top: 1rem; font-size: 0.9rem; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export default async function seedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/seed', async (request, reply) => {
    assertValidToken(request);
    const userCount = await app.prisma.user.count();
    reply.type('text/html');

    if (userCount > 0) {
      return renderPage(
        '<h1>Al geconfigureerd</h1><p>Er bestaat al minstens één gebruiker. Deze eenmalige setup-pagina doet niets meer.</p>',
      );
    }

    return renderPage(`
      <h1>Eerste beheerder aanmaken</h1>
      <p>Dit werkt maar één keer, zolang er nog geen enkele gebruiker bestaat.</p>
      <form id="f">
        <label>Naam
          <input name="displayName" required autocomplete="name">
        </label>
        <label>E-mailadres
          <input name="email" type="email" required autocomplete="email">
        </label>
        <label>Wachtwoord (min. 8 tekens)
          <input name="password" type="password" minlength="8" required autocomplete="new-password">
        </label>
        <button type="submit">Aanmaken</button>
      </form>
      <p id="msg"></p>
      <script>
        document.getElementById('f').addEventListener('submit', async (event) => {
          event.preventDefault();
          const msg = document.getElementById('msg');
          const fd = new FormData(event.target);
          try {
            const res = await fetch(window.location.pathname + window.location.search, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                displayName: fd.get('displayName'),
                email: fd.get('email'),
                password: fd.get('password'),
              }),
            });
            const data = await res.json();
            if (res.ok) {
              msg.textContent = 'Aangemaakt! Je kan nu inloggen op de app.';
              event.target.reset();
            } else {
              msg.textContent = 'Fout: ' + (data && data.error && data.error.message ? data.error.message : res.status);
            }
          } catch (err) {
            msg.textContent = 'Onverwachte fout — probeer opnieuw.';
          }
        });
      </script>
    `);
  });

  app.post('/admin/seed', async (request, reply) => {
    assertValidToken(request);

    const userCount = await app.prisma.user.count();
    if (userCount > 0) {
      throw new ApiError(409, 'ALREADY_SEEDED', 'Er bestaat al minstens één gebruiker.');
    }

    const body = seedBodySchema.parse(request.body);
    const passwordHash = await hashPassword(body.password);

    await app.prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: 'ADMIN',
        employee: { create: { displayName: body.displayName } },
      },
    });

    reply.code(201);
    return { success: true };
  });
}
