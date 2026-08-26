-- Sectie 6: "manueel tijd toevoegen indien toegestaan".
-- Voegt een informatief vlag toe aan time_entry om manueel ingegeven
-- registraties (vaste start-/eindtijd, geen timer) te onderscheiden van
-- registraties die via START/PAUZE/STOP tot stand kwamen.
ALTER TABLE "time_entry" ADD COLUMN "is_manual" BOOLEAN NOT NULL DEFAULT false;
