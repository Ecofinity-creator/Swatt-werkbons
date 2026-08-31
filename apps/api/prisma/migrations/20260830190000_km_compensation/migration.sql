-- Phase 12, deel D: kilometervergoeding (sectie 5).
-- Niet-destructief: alle nieuwe kolommen zijn nullable / hebben een veilige
-- default; bestaand gedrag blijft ongewijzigd zolang km_rate_cents niet
-- ingesteld is.
ALTER TABLE "company_settings" ADD COLUMN "km_rate_cents" INTEGER;
ALTER TABLE "project" ADD COLUMN "km_distance_one_way_meters" INTEGER;
ALTER TABLE "work_order" ADD COLUMN "km_amount_cents" INTEGER;
