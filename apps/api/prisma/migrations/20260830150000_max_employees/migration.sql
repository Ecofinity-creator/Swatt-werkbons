-- Licentiebeperking: max. aantal medewerkeraccounts per deployment (betaalplan).
-- Niet-destructief: null = geen limiet, bestaand gedrag blijft ongewijzigd.
ALTER TABLE "company_settings" ADD COLUMN "max_employees" INTEGER;
