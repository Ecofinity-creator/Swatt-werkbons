# Fase 34 — Plaats van tewerkstelling op de factuurhoofding

**Status: GEÏMPLEMENTEERD, wacht op bevestiging door Steven na testen.**

## Klantvraag

Bij de controle van een Teamleader-conceptfactuur (zie `phase-review` van
`Factuur_-_2026-09-16T083013.543.pdf`, 16/9/2026) merkte Steven op dat de
plaats van tewerkstelling ontbrak op de vetgedrukte weekhoofding
("Week N - naam"). Hij had dit eerst nagevraagd bij de klant vooraleer te
bepalen waar die informatie vandaan moest komen.

Op 20/9/2026 kwam het antwoord, letterlijk:

> "de plaats van tewerkstelling moet kunnen ingesteld worden in het project
> door de supervisor. default wordt door de app al het klantadres ingevuld
> wat meestal ook juist is."

Drie concrete eisen daarin:

1. Instelbaar **per project** (niet bedrijfsbreed, niet per werkbon).
2. Instelbaar door een **SUPERVISOR** (niet ADMIN-only, in tegenstelling tot
   de andere projectinstellingen met financiële impact zoals Verkoopprijs,
   Kilometervergoeding, Toeslagen & overurenregeling).
3. **Default = het klantadres** dat de app al gebruikt (`Project.address`,
   gesynchroniseerd vanuit Teamleader) — "meestal ook juist", dus geen
   verplicht in te vullen veld, enkel een override voor de uitzondering
   (bv. een werf/filiaal met een ander adres dan het facturatieadres van de
   klant).

## Ontwerpbeslissing: supervisor-override, geen verplicht veld

In plaats van een nieuw verplicht veld dat elke keer opnieuw ingevuld moet
worden, kreeg `Project` een **nullable** kolom `workLocationAddress`:

- `null` (default, ook voor alle bestaande projecten): de factuurhoofding
  gebruikt gewoon `Project.address` — exact het gedrag dat Steven als
  "meestal ook juist" omschreef, zonder dat er iets hoeft te gebeuren.
- Ingevuld: overschrijft `Project.address` op de factuurhoofding, voor de
  gevallen waarin de werf niet op het klant-/factuuradres ligt.

Dit is bewust **niet** hetzelfde niveau als Verkoopprijs/Kilometervergoeding/
Toeslagen (allemaal ADMIN-only, want rechtstreekse impact op het
factuurbedrag). Een adresvermelding op de hoofding heeft geen financiële
impact — vandaar SUPERVISOR-niveau, exact zoals de bestaande
Ondertekening-instelling (`signingMode`) en de milestone-koppeling.

## Wijzigingen

### Database (`apps/api/prisma/schema.prisma` + migratie)

Nieuwe kolom op `Project`:

```prisma
workLocationAddress String? @map("work_location_address")
```

Migratie: `apps/api/prisma/migrations/20260920090000_project_work_location_address/migration.sql`
— niet-destructief, `ALTER TABLE "project" ADD COLUMN "work_location_address" TEXT;`.

### Backend

- **Nieuwe route** `POST /admin/projects/:id/work-location`
  (`apps/api/src/modules/projects/project.routes.ts`), gated
  `requireRole('SUPERVISOR')` — zelfde patroon als de bestaande
  `km-settings`/`hourly-rate`-routes, maar op supervisor-niveau in plaats van
  admin-niveau.
- **Zod-schema** `updateProjectWorkLocationBodySchema`
  (`apps/api/src/modules/projects/project.schemas.ts`): trimt de invoer en
  zet een lege string om naar `null` (= override wissen, terugvallen op het
  klantadres).
- **`ProjectSummary`** (`packages/shared-types/src/index.ts`) en
  `toProjectSummary()` breidden uit met `workLocationAddress: string | null`.
- **`TeamleaderInvoiceService`** (`apps/api/src/modules/teamleader/teamleader-invoice.service.ts`):
  - `DraftBatchLineRow.workOrder.project` kreeg `address`/`workLocationAddress`
    (Prisma's `project: true`-include in `WITH_DRAFT_DETAILS` haalde het veld
    al automatisch mee — enkel het handgeschreven TS-type moest bijgewerkt).
  - `sectionTitle(group)` gebruikt nu `group.project.workLocationAddress ??
    group.project.address` en voegt dat — indien aanwezig — toe aan de
    hoofding: **"Week 32 - Peter Janssens - Kerkstraat 12, 9000 Gent"**. Is
    geen van beide gekend (project zonder adres), dan blijft de hoofding
    ongewijzigd zoals voorheen ("Week 32 - Peter Janssens") — nooit een
    lege/rare toevoeging.

### Frontend (`apps/web/src/pages/admin/ProjectMilestonesPage.tsx`)

Nieuw paneel **"Plaats van tewerkstelling"**, zichtbaar voor SUPERVISOR+
(geen `isAdmin`-check, in tegenstelling tot de panelen erboven), tussen
Kilometervergoeding en Kilometerafstand. Een tekstveld dat bij leeg laten
het klantadres als placeholder toont (dus visueel duidelijk wat de default
is) en bij blur opslaat; leeg = override wissen.

### Tests

`apps/api/test/teamleader-invoice.service.test.ts` — `FakeProject` kreeg de
twee nieuwe velden (`project1`-fixture: bewust `null`/`null`, zodat de
bestaande tests exact hetzelfde blijven verwachten: "Week 34 - Peter
Janssens" zonder plaats-suffix). Drie nieuwe tests in een aparte
`describe`-blok:

1. Terugval op het klantadres wanneer geen override is ingesteld.
2. De supervisor-override wint wanneer beide ingesteld zijn.
3. Geen plaats-suffix wanneer noch een override, noch een klantadres bekend
   is.

Alle 22 tests in dit bestand slagen (19 bestaand + 3 nieuw).

## Verificatie uitgevoerd

- `npm run build --workspace=packages/shared-types` — schoon.
- `npx tsc -p apps/api/tsconfig.json --noEmit` — geen nieuwe fouten (enkel de
  bekende, vooraf bestaande stale-Prisma-client-fouten door het ontbreken
  van netwerktoegang tot `binaries.prisma.sh` in de sandbox — zie eerdere
  fases).
- `npm run lint --workspace=apps/api` / `--workspace=apps/web` — beide schoon.
- `npm run build --workspace=apps/web` — schoon, volledige vite-build slaagt.
- `npx vitest run apps/api/test/teamleader-invoice.service.test.ts` — 22/22
  geslaagd (met lokaal ingestelde dummy `DATABASE_URL`/`SESSION_COOKIE_SECRET`,
  enkel nodig omdat het importeren van `teamleader-auth.service.ts` de
  environment-validatie triggert — geen echte databank nodig voor deze
  unit-tests).
- `npx prisma validate` kon in de sandbox niet draaien (geen netwerktoegang
  tot `binaries.prisma.sh`, bekende sandboxbeperking) — de migratie is
  manueel nagekeken tegen het bestaande migratiepatroon
  (`20260830090000_project_invoicing_enabled`) en is triviaal
  (`ALTER TABLE ... ADD COLUMN`, nullable, geen data-migratie nodig).

**Nog te doen door Steven na `npm install`/migreren op zijn machine:**
`npx prisma migrate deploy` (of via het bestaande deploy-mechanisme op
Render) om de nieuwe kolom effectief aan te maken, en manueel testen dat het
nieuwe paneel op het projectscherm verschijnt en de factuurhoofding
overeenkomstig aanpast.
