#!/usr/bin/env bash
#
# Fase 26 — voorbereiding voor een volgende klant naast Swatt.
#
# Vervangt de hardcoded Swatt-namen (Render-servicenaam "swatt-api" en de
# Vercel-frontend-URL) door de naam van een nieuwe klant, overal waar dat
# nodig is (render.yaml, apps/web/vercel.json, apps/web/.env.example,
# README.md). Bedoeld voor gebruik ONMIDDELLIJK na het klonen van deze repo
# voor een nieuwe klant — vóór de eerste commit/push naar hun eigen remote.
#
# Waarom dit script bestaat: apps/web/vercel.json's `rewrites` hardcoden de
# backend-hostnaam op ~15 plekken. Eén vergeten regel bij een handmatige
# kopie herhaalt exact het bugpatroon van Fase 19/24 (een route die stil
# terugvalt op de verkeerde plek i.p.v. een duidelijke fout te geven). Dit
# script vervangt alle plekken in één beweging, reviewbaar via `git diff`
# vóór je commit.
#
# Gebruik:
#   scripts/onboard-new-client.sh <client-slug> [frontend-url]
#
# Voorbeeld:
#   scripts/onboard-new-client.sh acme https://acme-werkbons.vercel.app
#
# <client-slug>: korte naam (kleine letters, cijfers, koppeltekens), wordt
#   gebruikt voor de Render-servicenamen: <slug>-api, <slug>-postgres,
#   <slug>-redis. De backend-hostnaam wordt dus automatisch <slug>-api.onrender.com
#   (Render's standaardpatroon <servicenaam>.onrender.com).
#
# [frontend-url]: optioneel. Nog niet gekend vóór het Vercel-project bestaat?
#   Laat weg — het script vult dan een duidelijke placeholder in die je later
#   met een normale zoek-en-vervang kan invullen (zie de eindmelding van dit
#   script).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Gebruik: $0 <client-slug> [frontend-url]" >&2
  echo "Voorbeeld: $0 acme https://acme-werkbons.vercel.app" >&2
  exit 1
fi

SLUG="$1"
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Fout: <client-slug> mag enkel kleine letters, cijfers en koppeltekens bevatten, en moet starten met een letter/cijfer." >&2
  exit 1
fi

BACKEND_HOST="${SLUG}-api.onrender.com"
FRONTEND_URL="${2:-https://VERVANG-MIJ-${SLUG}.vercel.app}"

OLD_BACKEND_HOST="swatt-api.onrender.com"
OLD_FRONTEND_URL="https://swatt-werkbons-web.vercel.app"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "Nieuwe backend-hostnaam:  $BACKEND_HOST"
echo "Nieuwe frontend-URL:      $FRONTEND_URL"
echo

FILES=(
  "render.yaml"
  "apps/web/vercel.json"
  "apps/web/.env.example"
  "apps/web/vite.config.ts"
  "README.md"
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "Waarschuwing: $f niet gevonden, overgeslagen." >&2
    continue
  fi
  # macOS/BSD sed vereist een lege backup-extensie na -i; GNU sed accepteert
  # -i '' ook, dus dit werkt op beide.
  sed -i.bak \
    -e "s#${OLD_BACKEND_HOST}#${BACKEND_HOST}#g" \
    -e "s#${OLD_FRONTEND_URL}#${FRONTEND_URL}#g" \
    "$f"
  rm -f "${f}.bak"
  echo "Bijgewerkt: $f"
done

# render.yaml: de service-/databasenamen zelf ook hernoemen (bepaalt de
# effectieve Render-hostnaam — moet overeenkomen met BACKEND_HOST hierboven).
if [[ -f render.yaml ]]; then
  sed -i.bak \
    -e "s#name: swatt-postgres#name: ${SLUG}-postgres#g" \
    -e "s#name: swatt-redis#name: ${SLUG}-redis#g" \
    -e "s#name: swatt-api#name: ${SLUG}-api#g" \
    render.yaml
  rm -f render.yaml.bak
fi

cat <<EOF

Klaar. Controleer de wijzigingen met 'git diff' vóór je commit.

Nog HANDMATIG te doen (dit script kan/mag dit niet automatisch doen):

1. Als je de frontend-URL hierboven nog niet kende: maak eerst het
   Vercel-project aan, en vervang dan overal de placeholder
   "https://VERVANG-MIJ-${SLUG}.vercel.app" door de echte URL (grep ernaar).
2. Nieuwe, unieke secrets — NOOIT hergebruiken van Swatt's deployment:
   SESSION_COOKIE_SECRET, TEAMLEADER_TOKEN_ENCRYPTION_KEY, SEED_TOKEN
   (render.yaml genereert deze automatisch bij een nieuwe Blueprint-deploy,
   dus dit is enkel relevant als je handmatig een Render-service aanmaakt
   i.p.v. via render.yaml).
3. Teamleader: voeg https://${BACKEND_HOST}/teamleader/oauth/callback toe
   aan de whitelist van redirect-URI's op de bestaande "Uurivo"-integratie
   in developer.focus.teamleader.eu (één app-registratie ondersteunt
   meerdere whitelisted redirect-URI's — geen nieuwe app-registratie nodig).
4. Na de eerste deploy: eerste ADMIN-gebruiker aanmaken via /admin/seed,
   CompanySettings invullen (bedrijfsnaam/logo/BTW/max_employees volgens
   het gekozen plan), en een verwerkersovereenkomst (GDPR) met deze klant.
5. .git-remote van deze kloon naar de nieuwe klant-repo verzetten
   ('git remote set-url origin <nieuwe-repo-url>') vóór de eerste push —
   dit script wijzigt geen git-remotes.
EOF
