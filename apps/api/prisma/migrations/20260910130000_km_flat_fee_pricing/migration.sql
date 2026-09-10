-- Klantvraag 10/9/2026: verplaatsingsvergoeding per project i.p.v. één vlak
-- bedrijfstarief (CompanySettings.kmRateCents, vanaf nu @deprecated, kolom
-- blijft bestaan) — "prijs voor de eerste x km is een vaste prijs, daarboven
-- een tarief per km." Defaults (65 km / € 35,00 / € 0,80 per km) gelden voor
-- zowel bestaande als nieuwe projecten; per project aanpasbaar via de nieuwe
-- "Kilometervergoeding"-instelling (ADMIN-only).
ALTER TABLE "project" ADD COLUMN "km_flat_fee_threshold_km" INTEGER NOT NULL DEFAULT 65;
ALTER TABLE "project" ADD COLUMN "km_flat_fee_cents" INTEGER DEFAULT 3500;
ALTER TABLE "project" ADD COLUMN "km_rate_above_cents_per_km" INTEGER NOT NULL DEFAULT 80;

-- "Verplaatsing manueel kunnen ingeven, want sommige medewerkers vertrekken
-- van thuis" — bevroren effectieve rijafstand (één richting, meter) bij
-- ondertekenen, zelfde bevriesmoment als km_amount_cents hierboven. Nullable,
-- geen default: `null` tot een werkbon effectief ondertekend wordt.
ALTER TABLE "work_order" ADD COLUMN "km_distance_one_way_meters" INTEGER;
