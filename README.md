# Swatt Werkbon-app

Mobiele tijdregistratie + digitale werkbon + Teamleader Focus-integratie voor Swatt BV (Izegem).

Volledige functionele analyse, architectuur, Teamleader API-analyse, datamodel, UX en development-roadmap staan in het projectfundamentendocument (Stap 1 t/m 6). **Phase 1 — Foundation** (projectskelet, login/sessies, RBAC, CI/CD naar Vercel + Render) is afgerond en live. Dit is nu ook uitgebreid met **Phase 2 — Teamleader OAuth**: een admin kan de Teamleader-koppeling leggen/verbreken, met automatische, veilig versleutelde token-refresh.

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
  TEAMLEADER_CLIENT_ID="test-client-id" \
  TEAMLEADER_CLIENT_SECRET="test-client-secret" \
  TEAMLEADER_REDIRECT_URI="http://localhost:3000/teamleader/oauth/callback" \
  TEAMLEADER_TOKEN_ENCRYPTION_KEY="H81ZAvO1tYqfCsYg/Eek8HrcevSTboS+aLWOfjEV47E=" \
  npm test
```

De vier `TEAMLEADER_*`-waarden hierboven zijn vaste test-waarden (geen echte
secrets) — nodig omdat de Phase 2-tests anders overslaan/falen op een "niet
geconfigureerd"-fout. Ze worden nooit echt naar Teamleader gestuurd: alle
Teamleader-tests mocken `fetch` (zie `test/teamleader-auth.service.test.ts`
en `test/teamleader.routes.integration.test.ts`).

Dekking in Phase 1:
- **Unit** (`apps/api/test/rbac.middleware.test.ts`): RBAC-hiërarchie (EMPLOYEE < SUPERVISOR < ADMIN), geen Fastify/database nodig.
- **Integratie** (`apps/api/test/auth.integration.test.ts`): volledige login → /auth/me → logout-flow tegen een echte Postgres-testdatabase, inclusief RBAC afgedwongen tot op HTTP-niveau (403 op een admin-route voor een EMPLOYEE) en de mensentaal-foutmeldingen uit sectie 27 van de projectbrief.

Dekking in Phase 2 (Teamleader OAuth):
- **Unit** (`apps/api/test/token-crypto.service.test.ts`): AES-256-GCM round-trip, unieke IV per encryptie, integriteitscheck (gemanipuleerde ciphertext wordt geweigerd).
- **Unit** (`apps/api/test/teamleader-auth.service.test.ts`): authorize-URL-opbouw, token-exchange met versleutelde opslag, hergebruik van een nog geldig token, automatische refresh vóór verval, **race-condition-test** (twee gelijktijdige aanvragen voor een verlopen token triggeren maar één refresh-call naar Teamleader), foutafhandeling bij een mislukte refresh (status → ERROR, vraagt om opnieuw te verbinden), en het volledig verbreken van een koppeling. `fetch` wordt gemockt; geen echte Prisma-client nodig (enkel `import type`).
- **Unit** (`apps/api/test/teamleader-not-configured.test.ts`): duidelijke `TEAMLEADER_NOT_CONFIGURED`-fout i.p.v. een crash wanneer de vier env-variabelen nog niet gezet zijn (eigen module-mock, los van de omgeving).
- **Integratie** (`apps/api/test/teamleader.routes.integration.test.ts`): RBAC op alle vier de routes (enkel ADMIN), de volledige authorize → callback → CONNECTED-flow (incl. correcte `connectedByUserId`), CSRF-bescherming via de `state`-cookie (state-mismatch wordt geweigerd), Teamleader's `error`-parameter (klant weigert), en het verbreken van de koppeling.

## Typecheck & lint

```bash
npm run typecheck
npm run lint
```

## Deployment

- **Frontend → Vercel:** repo koppelen, Root Directory instellen op `apps/web`. Environment variable `VITE_API_URL` zetten naar de Render-backend-URL.
- **Backend → Render:** `render.yaml` in de repo-root wordt automatisch herkend bij het aanmaken van een nieuwe Blueprint-deploy op Render. Voegt een Postgres-database en de API-service toe; `SESSION_COOKIE_SECRET` wordt automatisch gegenereerd.
- Na de eerste Render-deploy: de echte Render-URL invullen als `VITE_API_URL` op Vercel, en de echte Vercel-URL invullen als `CORS_ORIGINS` op Render (in `render.yaml` of rechtstreeks in de Render-dashboard env vars).

## Teamleader koppelen (Phase 2)

1. Registreer een integratie op [developer.focus.teamleader.eu](https://developer.focus.teamleader.eu) en noteer `client_id`/`client_secret`.
2. Zet als redirect-URI exact de backend-callback-URL, bv. `https://swatt-api.onrender.com/teamleader/oauth/callback` (productie) of `http://localhost:3000/teamleader/oauth/callback` (lokaal).
3. Zet de vier `TEAMLEADER_*`-environment-variabelen (zie `apps/api/.env.example`) — lokaal in `.env`, in productie in het Render-dashboard. `TEAMLEADER_TOKEN_ENCRYPTION_KEY` genereer je met `openssl rand -base64 32`.
4. Log in als ADMIN, ga naar **Instellingen → Teamleader-integratie**, en klik **Verbind met Teamleader**.
5. **Nog te verifiëren tegen het echte Swatt-account (zie openstaand actiepunt in het fundamentendocument):** gebruikt dit account de legacy of de `projects-v2`-projectenmodule — bepaalt de implementatie van `ProjectSyncService` in Phase 3.

## Beperkingen van deze fase (Phase 1 + 2)

- Geen wachtwoord-reset-flow (komt met de eerste "echte" gebruikersbeheer-fase).
- Geen rate-limiting op `/auth/login` nog (gepland voor Phase 12 — production hardening), dus **niet production-ready tegen brute-force** in deze vorm.
- Redis/BullMQ bestaan nog niet — die komen in Phase 8/9 (PDF-generatie, Teamleader-sync van tijd/bestanden).
- Teamleader OAuth is klaar (Phase 2), maar er wordt nog **niets** effectief gesynchroniseerd — geen projecten, gebruikers, tijdregistraties of bestanden. Dat begint in Phase 3.
- Geen enkele project-, timer- of werkbon-functionaliteit — uitsluitend login/sessie/RBAC + de Teamleader-koppeling zelf, zoals gepland.
- Sleutelrotatie van `TEAMLEADER_TOKEN_ENCRYPTION_KEY` is niet ondersteund: een nieuwe sleutel maakt bestaande versleutelde tokens onleesbaar, dus dat vereist opnieuw verbinden via het admin-scherm (bewuste MVP-beperking, zie commentaar in `token-crypto.service.ts`).
