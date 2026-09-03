-- Werknemer vs. Onderaannemer — uren-export (sectie 3/9/2026): "als
-- geëxporteerd markeren zodat een tijdregistratie niet dubbel meetelt in een
-- volgende export". Nullable, geen default nodig — alle bestaande
-- tijdregistraties starten terecht als "nog niet geëxporteerd".
ALTER TABLE "time_entry" ADD COLUMN "hours_exported_at" TIMESTAMPTZ;
