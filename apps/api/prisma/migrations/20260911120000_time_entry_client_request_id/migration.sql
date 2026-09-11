-- Offline-modus (11/9/2026): idempotentiesleutel voor createManual(), zodat
-- een herhaalde POST vanuit de offline-wachtrij (bv. omdat het antwoord op
-- een eerdere, wél geslaagde poging onderweg verloren ging) geen tweede,
-- dubbel gefactureerde/doorbetaalde tijdregistratie aanmaakt. Nullable en
-- optioneel — een manuele registratie via de normale (online) flow stuurt
-- dit niet mee en blijft gewoon werken.
ALTER TABLE "time_entry" ADD COLUMN "client_request_id" TEXT;

CREATE UNIQUE INDEX "time_entry_client_request_id_key" ON "time_entry"("client_request_id");
