
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

# Backend, frontend én de Teamleader-syncworker elk in een eigen terminal
npm run dev:api
npm run dev:web
npm run dev:worker --workspace=apps/api
```

Frontend op http://localhost:5173, backend op http://localhost:3000 (de Vite-dev-proxy stuurt `/auth` en `/health` automatisch door).

De derde terminal (`dev:worker`, Phase 9) verwerkt de Teamleader-synctaken (tijdregistraties + PDF-upload) van de BullMQ-queue. Zonder deze terminal blijft een werkbon na ondertekenen op `SYNC_PENDING` staan totdat je de worker alsnog start of de API-server herstart (die herqueuet openstaande taken automatisch bij opstarten, zie `SyncJobService.reconcilePendingJobs`).

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

`REDIS_URL` heeft een default (`redis://localhost:6379`, zie `apps/api/src/config/env.ts`)
en hoeft dus niet expliciet meegegeven te worden — wel moet `docker compose up -d`
gedraaid hebben zodat die Redis-instance lokaal bereikbaar is (nodig voor elke test die
effectief de Teamleader-syncqueue raakt, zie "Dekking in Phase 9" hieronder).

Dekking in Phase 1:
- **Unit** (`apps/api/test/rbac.middleware.test.ts`): RBAC-hiërarchie (EMPLOYEE < SUPERVISOR < ADMIN), geen Fastify/database nodig.
- **Integratie** (`apps/api/test/auth.integration.test.ts`): volledige login → /auth/me → logout-flow tegen een echte Postgres-testdatabase, inclusief RBAC afgedwongen tot op HTTP-niveau (403 op een admin-route voor een EMPLOYEE) en de mensentaal-foutmeldingen uit sectie 27 van de projectbrief.

Dekking in Phase 2 (Teamleader OAuth):
- **Unit** (`apps/api/test/token-crypto.service.test.ts`): AES-256-GCM round-trip, unieke IV per encryptie, integriteitscheck (gemanipuleerde ciphertext wordt geweigerd).
- **Unit** (`apps/api/test/teamleader-auth.service.test.ts`): authorize-URL-opbouw, token-exchange met versleutelde opslag, hergebruik van een nog geldig token, automatische refresh vóór verval, **race-condition-test** (twee gelijktijdige aanvragen voor een verlopen token triggeren maar één refresh-call naar Teamleader), foutafhandeling bij een mislukte refresh (status → ERROR, vraagt om opnieuw te verbinden), en het volledig verbreken van een koppeling. `fetch` wordt gemockt; geen echte Prisma-client nodig (enkel `import type`).
- **Unit** (`apps/api/test/teamleader-not-configured.test.ts`): duidelijke `TEAMLEADER_NOT_CONFIGURED`-fout i.p.v. een crash wanneer de vier env-variabelen nog niet gezet zijn (eigen module-mock, los van de omgeving).
- **Integratie** (`apps/api/test/teamleader.routes.integration.test.ts`): RBAC op alle vier de routes (enkel ADMIN), de volledige authorize → callback → CONNECTED-flow (incl. correcte `connectedByUserId`), CSRF-bescherming via de `state`-cookie (state-mismatch wordt geweigerd), Teamleader's `error`-parameter (klant weigert), en het verbreken van de koppeling.

Dekking in Phase 9 (Teamleader-sync):
- **Unit** (`apps/api/test/teamleader-user.service.test.ts`): live opvraging + sortering van actieve Teamleader-gebruikers, fallback op e-mailadres zonder naam, foutafhandeling.
- **Unit** (`apps/api/test/milestone-sync.service.test.ts`): cachen/archiveren van Teamleader-milestones, hergebruik van een reeds gekozen milestone, `TEAMLEADER_MILESTONE_NOT_CONFIGURED` zonder default-verantwoordelijke, automatische `milestones.create`-aanmaak mét, en de validatie dat een gekozen milestone bij het juiste project hoort.
- **Unit** (`apps/api/test/time-tracking-sync.service.test.ts`): **idempotentie** (business rule 5 — een SYNCED registratie wordt nooit opnieuw gepost), correcte pauzetijd-aftrek (`started_at`+`duration`, niet `ended_at`), mensentaal-fout bij een niet-gekoppelde medewerker zonder de andere registraties te blokkeren, en foutafhandeling per registratie bij een Teamleader-API-fout.
- **Unit** (`apps/api/test/file-sync.service.test.ts`): subjecttype-keuze (`project` legacy vs. `nextgenProject`), business rule 6 (vorig Teamleader-bestand best-effort verwijderen, nooit blokkerend), fallback via `files.list` wanneer stap 2 geen bruikbaar file-ID teruggeeft, en mensentaal-foutafhandeling.
- **Unit** (`apps/api/test/sync-job.service.test.ts`): SyncJob-aanmaak + queueing, `retry()` slaat reeds `SUCCEEDED` jobs over, `WorkOrder.status`-afleiding (sectie 34 stap 9 — `SYNC_PENDING` → `READY_FOR_INVOICING`/`SYNC_FAILED`, nooit terug vanaf `INVOICED` per business rule 7), en `reconcilePendingJobs()` bij serverherstart.

Deze vijf bestanden gebruiken een fake-Prisma/fake-TeamleaderClient (geen echte database of Redis-verbinding nodig) — `getSyncQueue()` wordt in `sync-job.service.test.ts` met `vi.mock` vervangen. Integratietests voor de nieuwe/gewijzigde routes (`/work-orders/:id/sync/retry`, `/admin/work-orders/sync-issues`, `/admin/teamleader/users`, `/admin/teamleader/settings`, `/admin/projects/:id/milestones/*`) zijn nog niet geschreven — dat vereist een écht gegenereerde Prisma-client (zie de Prisma-beperking hieronder) en is dus enkel end-to-end te verifiëren in CI/lokaal met een werkende `prisma generate`, niet in de ontwikkelsandbox waarin Phase 9 gebouwd is.

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
5. **Bevestigd door Steven:** Swatt/Ecofinity's Teamleader-account gebruikt de **legacy-projectenmodule** (niet `projects-v2`) — `ProjectSyncService` (Phase 3) en de Phase 9-tijdregistratiesync (`milestone`-subject, zie hieronder) zijn daarop gebouwd. **Nog open:** of de koppeling al effectief naar Ecofinity's eigen Teamleader-account staat (i.p.v. een test-/demo-account) — controleer dit bij **Instellingen → Teamleader-integratie** vóór er echte klantwerkbonnen op verwerkt worden.

## E-mail koppelen (uitnodigingen + wachtwoord vergeten)

Nieuwe gebruikers krijgen geen wachtwoord meer van de admin, maar een uitnodigingsmail met een link om er zelf een
in te stellen; diezelfde link (via "Wachtwoord vergeten" op het inlogscherm) werkt ook om een bestaand wachtwoord
te resetten. Dit loopt via [Resend](https://resend.com):

1. Maak een gratis Resend-account aan (3.000 e-mails/maand gratis).
2. Ofwel meteen testen met de Resend-sandboxafzender `onboarding@resend.dev` (levert enkel af aan het e-mailadres
   van je eigen Resend-account — voldoende om de flow te testen), ofwel een eigen verzenddomein verifiëren via de
   DNS-instructies in het Resend-dashboard voor echte productie-verzending.
3. Maak een API-key aan in het Resend-dashboard.
4. Zet `RESEND_API_KEY` en `EMAIL_FROM_ADDRESS` (zie `apps/api/.env.example`) — lokaal in `.env`, in productie
   rechtstreeks in de Render-dashboard env vars (nooit in code of chat delen).

Zonder deze configuratie blijft de rest van de app gewoon werken (business rule 9): een nieuwe gebruiker wordt dan
wel aangemaakt, maar zonder uitnodigingsmail — de admin ziet dat in het scherm **Medewerkers** en kan de betrokkene
vragen "Wachtwoord vergeten" te gebruiken zodra de e-mailkoppeling actief is.

## Beperkingen van deze fase (Phase 1 t/m 9)

- Geen rate-limiting op `/auth/login` nog (gepland voor Phase 12 — production hardening), dus **niet production-ready tegen brute-force** in deze vorm.
- Sleutelrotatie van `TEAMLEADER_TOKEN_ENCRYPTION_KEY` is niet ondersteund: een nieuwe sleutel maakt bestaande versleutelde tokens onleesbaar, dus dat vereist opnieuw verbinden via het admin-scherm (bewuste MVP-beperking, zie commentaar in `token-crypto.service.ts`).
- **Phase 9 — Teamleader-sync (tijd + PDF)**, zie `claude/phase9-teamleader-sync.md` in het Claude-project voor de volledige overdrachtsnotitie:
  - Swatt/Ecofinity's Teamleader-account gebruikt de **legacy-projectenmodule** (bevestigd door Steven) — de sync is daarop gebouwd (`timeTracking.add` met een `milestone`-subject, per het officiële blueprint; Projects V2 heeft geen gedocumenteerde manier om tijd aan een project/taak te koppelen).
  - Een project heeft standaard geen "werkbon-uren"-milestone. Een supervisor kan er via **Backoffice → Projecten** expliciet één kiezen uit de bestaande Teamleader-milestones van dat project; zonder keuze maakt de app er zelf één aan bij de eerste sync — dat vereist wel dat een admin bij **Instellingen → Teamleader-integratie** een "verantwoordelijke" Teamleader-gebruiker heeft ingesteld (verplicht veld bij `milestones.create`).
  - Elke medewerker moet gekoppeld zijn aan een Teamleader-gebruiker (**Backoffice → Medewerkers → [medewerker] → Teamleader-gebruiker**) vóór zijn/haar uren gesynchroniseerd kunnen worden — zonder koppeling faalt de sync met een duidelijke melding, de andere medewerkers op dezelfde werkbon blijven wel gewoon synchroniseren.
  - **Stap 2 van `files.upload` (de eigenlijke PDF-bytes posten naar de kortstondige upload-URL) is niet gedocumenteerd in het officiële blueprint en dus NIET live geverifieerd** tegen een echt Teamleader-account — geïmplementeerd als een gangbare `multipart/form-data`-POST (veldnaam `file`). Bij een afwijzing logt de backend de volledige Teamleader-responstekst; dit is de eerste plek om te controleren zodra er een echte Teamleader-koppeling actief is.
  - De achtergrondwerker (`npm run dev:worker --workspace=apps/api` lokaal, aparte `swatt-sync-worker`-service op Render) moet naast de gewone API-server draaien, anders blijven synctaken op `PENDING` staan totdat de API-server opnieuw opstart (`reconcilePendingJobs()`, zie `server.ts`) of een admin handmatig "Opnieuw synchroniseren" gebruikt.
  - Nog geen materialen/producten op een werkbon (sectie 18 van de projectbrief) — het datamodel houdt er wel rekening mee, maar dit is bewust nog niet gebouwd.
  - Nog geen automatische conceptfactuur in Teamleader (sectie 17) — het `WorkOrder.status`-traject stopt bij `READY_FOR_INVOICING`; de facturatiepagina zelf (filteren/selecteren/"Voorbereiden voor facturatie") is een latere fase.
