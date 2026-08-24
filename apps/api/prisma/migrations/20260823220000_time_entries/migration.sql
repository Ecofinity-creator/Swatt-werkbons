-- Phase 4 — timer ("START WERK"). Handmatig geschreven, net als de vorige
-- migraties: deze ontwikkelsandbox heeft geen netwerktoegang tot Prisma's
-- engine-CDN. Exacte SQL-vertaling van prisma/schema.prisma op dit punt
-- (nieuw TimeEntryStatus-enum + time_entry-tabel).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten.

CREATE TYPE "time_entry_status" AS ENUM ('RUNNING', 'PAUSED', 'STOPPED');

CREATE TABLE "time_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "time_entry_status" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "current_pause_started_at" TIMESTAMPTZ,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "time_entry_employee_id_idx" ON "time_entry"("employee_id");
CREATE INDEX "time_entry_project_id_idx" ON "time_entry"("project_id");

-- Business rule 1 (projectbrief sectie 24): een werknemer kan maar één
-- actieve timer tegelijk hebben. Afgedwongen op databankniveau via een
-- partiële unieke index (i.p.v. enkel in de service-laag) — dit blijft
-- correct zelfs bij twee gelijktijdige "start"-aanvragen voor dezelfde
-- werknemer (TimeEntryService vangt de resulterende unique-constraint-fout
-- op en vertaalt die naar de mensentaal TIME_ENTRY_ALREADY_ACTIVE-fout).
CREATE UNIQUE INDEX "time_entry_one_active_per_employee"
    ON "time_entry"("employee_id")
    WHERE "status" IN ('RUNNING', 'PAUSED');

ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
