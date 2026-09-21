# Fase 35 — "Ik ben ingelogd maar krijg toch de melding, en kan niet uitloggen"

**Status: GEFIXT, wacht op bevestiging na de volgende deploy + het wissen van de opgeslagen sitegegevens op Stevens telefoon.**

## Melding

Steven (test-account "Steven installateur", rol Werknemer) op Android/Chrome
(PWA "Uurivo" op het beginscherm):

> "ik krijg continu de melding dat ik niet ingelogd ben, niettegenstaande ik
> wel ben ingelogd" — screenshot van "Mijn projecten" met de rode balk "Je
> bent niet (meer) ingelogd. Log opnieuw in."

Daarna, na doorvragen:

> "ik kan ook niet uitloggen, krijg daar ook die melding."

Een screenshot van het thuisscherm toonde het tegenstrijdige beeld: bovenaan
gewoon "Ingelogd als Steven installateur — Werknemer", maar tegelijk
diezelfde rode foutbalk eronder.

## Root cause

Twee samenwerkende oorzaken:

1. **De service worker cachet `/auth/me`.** `apps/web/vite.config.ts`'s
   Workbox-`runtimeCaching` (offline-modus, sectie 16) gebruikt `NetworkFirst`
   met een timeout van 4 seconden voor o.a. `/auth/me`, `/projects`,
   `/time-entries` en `/work-orders` — bedoeld zodat "Mijn projecten"/de
   actieve timer bruikbaar blijft op een werf zonder bereik. Bij een trage of
   wisselvallige mobiele verbinding (>4s) valt dit terug op de laatst gekende
   cache — voor `/auth/me` dus mogelijk een tot 7 dagen oud "ingelogd"-
   antwoord, terwijl de échte server-side sessie intussen al verlopen is.
2. **`AuthContext.tsx` haalt `/auth/me` maar ÉÉN keer op** (bij het laden van
   de app, `useEffect` met lege dependency-array) en had geen enkel mechanisme
   om zijn `user`-state nadien nog bij te sturen. Zodra de (mogelijk gecachte)
   eerste `/auth/me` "ingelogd" teruggaf, bleef de hele UI dat de rest van de
   sessie beweren — ook nadat een ECHTE aanroep (Mijn projecten, en cruciaal:
   ook Uitloggen zelf, want `POST /auth/logout` vereist ook `app.authenticate`)
   intussen gewoon een oprechte 401 van de backend kreeg. `logout()` zelf
   maakte het erger: `await authApi.logout(); setUser(null);` — wanneer die
   `await` faalt (want de sessie is al weg), wordt `setUser(null)` NOOIT
   bereikt. Resultaat: een doodlopend schermpje, geen enkele weg terug naar
   het inlogscherm zonder handmatig de opgeslagen sitegegevens te wissen.

Dit is dus geen bug in mijn recent afgeleverde "plaats van
tewerkstelling"-feature (fase 34) — puur toeval in timing dat dit net
daarna gemeld werd.

## Fix

Bewust **geen** wijziging aan de offline-cachingconfiguratie zelf
(`vite.config.ts`) — dat is een doelbewust ontworpen offline-functie
(sectie 16) die niet lichtzinnig aangepast mag worden zonder de volledige
offline-opzet (fase 20) opnieuw te doorlopen. In plaats daarvan is het
symptoom rechtstreeks aangepakt: zodra ÉÉN echte (niet-gecachte) aanroep
ergens in de app een oprechte 401 met `NOT_AUTHENTICATED` teruggeeft, moet
de hele UI dat onmiddellijk weerspiegelen.

- **`apps/web/src/api/client.ts`** — nieuw event `SESSION_EXPIRED_EVENT`
  (en `PORTAL_SESSION_EXPIRED_EVENT` voor het klantportaal), gedispatcht
  vanuit de centrale `request()`-functie zodra de backend `NOT_AUTHENTICATED`
  resp. `CUSTOMER_PORTAL_NOT_AUTHENTICATED` teruggeeft.
- **`apps/web/src/auth/AuthContext.tsx`** — luistert op dat event en wist
  meteen `user` → `RequireAuth` (App.tsx) valt dan vanzelf terug op
  `/login`. `logout()` gebruikt nu `try { await authApi.logout(); } finally
  { setUser(null); }` — ook wanneer de servercall zelf faalt (sessie al
  weg), is de gebruiker lokaal alsnog uitgelogd en komt op het inlogscherm.
- **`apps/web/src/auth/PortalAuthContext.tsx`** — exact dezelfde twee fixes,
  voor het klantportaal (los systeem, eigen sessiecookie).

## Wat Steven nu meteen kan doen (vóór de volgende deploy al bruikbaar)

De service worker (`registerType: 'autoUpdate'`) haalt de nieuwe JS-bundle
vanzelf op zodra hij de app met bereik heropent, maar de reeds **gecachte
`/auth/me`-respons** (aparte Cache Storage, `uurivo-api-cache`) verdwijnt
pas na 7 dagen of een geslaagde verse aanroep. Snelste manier om nu al
gegarandeerd een schone staat te krijgen: op zijn telefoon, in Chrome, de
opgeslagen gegevens van de Uurivo-site wissen (Instellingen → Site-
instellingen → Uurivo → Opslag wissen), daarna de PWA opnieuw openen en
gewoon opnieuw inloggen. Vanaf de volgende deploy lost dit zichzelf sowieso
op: elke echte 401 (dus ook gewoon op de eerstvolgende pagina die hij
opent) stuurt hem dan automatisch naar het inlogscherm in plaats van vast
te zitten.

## Verificatie uitgevoerd

- `npm run lint --workspace=apps/web` — schoon.
- `npm run build --workspace=apps/web` — schoon, volledige vite-build +
  PWA-service-worker-generatie slaagt.
- Geen bestaande frontend-tests in dit project om te draaien (geen
  testbestanden onder `apps/web`).
