# Swatt Werkbon-app

Mobiele tijdregistratie + digitale werkbon + Teamleader Focus-integratie voor Swatt BV (Izegem).

Volledige functionele analyse, architectuur, Teamleader API-analyse, datamodel, UX en development-roadmap staan in het projectfundamentendocument (Stap 1 t/m 6). Dit is **Phase 1 — Foundation** uit die roadmap: projectskelet, login/sessies, RBAC, en CI/CD-koppeling naar Vercel + Render.

## Structuur (npm workspaces monorepo)

```
apps/
  api/    → backend: Node.js + TypeScript + Fastify + Prisma + PostgreSQL
  web/    → frontend: React + TypeScript + Vite + Tailwind (PWA volgt in Phase 11)
packages/
  shared-types/ → types gedeeld tussen api en web (o.a. UserRole, AuthenticatedUser)
```

## Lokaal opzetten

Vereisten: Node.js ≥ 20, Docker (voor Postgres/Redis) of een lokale Postgres 16.

```bash
npm install

# Postgres + Redis lokaal opstarten
docker compose up -d

# Environment-variabelen
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# → in apps/api/.env: genereer een echte SESSION_COOKIE_SECRET met `openssl rand -hex 32`

# Database-schema aanmaken
npm run prisma:migrate --workspace=apps/api

# Backend en frontend elk in een eigen terminal
npm run dev:api
npm run dev:web
```

Frontend op http://localhost:5173, backend op http://localhost:3000 (de Vite-dev-proxy stuurt `/auth` en `/health` automatisch door).

### Een eerste gebruiker aanmaken

Er is in Phase 1 bewust nog geen registratie-UI (gebruikersbeheer is een backoffice-scherm uit een latere fase). Maak lokaal een admin-account via een korte Node-REPL:

```bash
cd apps/api
node -e "
const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('./dist/modules/auth/password.service');
(async () => {
  const prisma = new PrismaClient();
  await prisma.user.create({
    data: {
      email: 'admin@swatt.be',
      passwordHash: await hashPassword('kies-hier-een-wachtwoord'),
      role: 'ADMIN',
      employee: { create: { displayName: 'Admin' } },
    },
  });
  await prisma.\$disconnect();
})();
"
```

(Vanaf Phase 3 vervangt een echt admin-scherm dit; dit is bewust een tijdelijke bootstrap-stap.)

## Tests draaien

```bash
# vereist een lege, migreerbare test-database
DATABASE_URL="postgresql://swatt:swatt_dev_local@localhost:5432/swatt_test" \
  npm run prisma:migrate:deploy --workspace=apps/api -- --schema=apps/api/prisma/schema.prisma

DATABASE_URL="postgresql://swatt:swatt_dev_local@localhost:5432/swatt_test" \
  SESSION_COOKIE_SECRET="test-secret-minstens-32-tekens-lang" \
  npm test
```

Dekking in Phase 1:
- **Unit** (`apps/api/test/rbac.middleware.test.ts`): RBAC-hiërarchie (EMPLOYEE < SUPERVISOR < ADMIN), geen Fastify/database nodig.
- **Integratie** (`apps/api/test/auth.integration.test.ts`): volledige login → /auth/me → logout-flow tegen een echte Postgres-testdatabase, inclusief RBAC afgedwongen tot op HTTP-niveau (403 op een admin-route voor een EMPLOYEE) en de mensentaal-foutmeldingen uit sectie 27 van de projectbrief.

## Typecheck & lint

```bash
npm run typecheck
npm run lint
```

## Deployment

- **Frontend → Vercel:** repo koppelen, Root Directory instellen op `apps/web`. Environment variable `VITE_API_URL` zetten naar de Render-backend-URL.
- **Backend → Render:** `render.yaml` in de repo-root wordt automatisch herkend bij het aanmaken van een nieuwe Blueprint-deploy op Render. Voegt een Postgres-database en de API-service toe; `SESSION_COOKIE_SECRET` wordt automatisch gegenereerd.
- Na de eerste Render-deploy: de echte Render-URL invullen als `VITE_API_URL` op Vercel, en de echte Vercel-URL invullen als `CORS_ORIGINS` op Render (in `render.yaml` of rechtstreeks in de Render-dashboard env vars).

## Beperkingen van deze fase (Phase 1)

- Geen wachtwoord-reset-flow (komt met de eerste "echte" gebruikersbeheer-fase).
- Geen rate-limiting op `/auth/login` nog (gepland voor Phase 12 — production hardening), dus **niet production-ready tegen brute-force** in deze vorm.
- Redis/BullMQ/Teamleader-koppeling bestaan nog niet — dat begint in Phase 2.
- Geen enkele Teamleader-, project-, timer- of werkbon-functionaliteit — uitsluitend login/sessie/RBAC, zoals gepland.
