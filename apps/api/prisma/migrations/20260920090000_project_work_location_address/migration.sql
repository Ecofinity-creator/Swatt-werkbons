-- Klantvraag 20/9/2026: "de plaats van tewerkstelling ontbreekt nog op de
-- hoofding van elke week" op de facturatie-PDF. Niet-destructief: nieuwe
-- nullable kolom, bestaand gedrag blijft ongewijzigd voor alle bestaande
-- projecten (sectionTitle() valt bij NULL terug op het klantadres, zie
-- teamleader-invoice.service.ts).
ALTER TABLE "project" ADD COLUMN "work_location_address" TEXT;
