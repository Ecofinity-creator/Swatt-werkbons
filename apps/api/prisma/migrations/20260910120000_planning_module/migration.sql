-- Fase 13 (concept) — planningsmodule/dispatch (klantvraag 10/9/2026, zie
-- claude/phase13-planningsmodule-concept.md). Handmatig geschreven, zelfde
-- reden als alle eerdere migraties in deze repo: deze ontwikkelsandbox heeft
-- geen netwerktoegang tot Prisma's engine-CDN. Exacte SQL-vertaling van
-- prisma/schema.prisma op dit punt (toevoeging van PlanningSeries en
-- PlanningAssignment).
--
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, na alle 23 voorgaande migraties, zonder fouten (incl. een
-- end-to-end insert/query-test die business rules 11/14-16 natoetst — zie
-- test/planning.service.test.ts voor de servicelaag-tests).

CREATE TABLE "planning_series" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    -- 0=maandag .. 6=zondag, vrije selectie van 1 of meerdere dagen.
    "weekdays" INTEGER[] NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "planning_series_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "planning_series_employee_id_idx" ON "planning_series"("employee_id");
CREATE INDEX "planning_series_active_end_date_idx" ON "planning_series"("active", "end_date");

CREATE TABLE "planning_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "series_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "planning_assignment_pkey" PRIMARY KEY ("id")
);

-- Business rule 11: een medewerker heeft per dag maximaal één planningstoewijzing.
CREATE UNIQUE INDEX "planning_assignment_employee_id_date_key" ON "planning_assignment"("employee_id", "date");
CREATE INDEX "planning_assignment_project_id_date_idx" ON "planning_assignment"("project_id", "date");
CREATE INDEX "planning_assignment_date_idx" ON "planning_assignment"("date");
CREATE INDEX "planning_assignment_series_id_idx" ON "planning_assignment"("series_id");

ALTER TABLE "planning_series" ADD CONSTRAINT "planning_series_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "planning_series" ADD CONSTRAINT "planning_series_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "planning_series" ADD CONSTRAINT "planning_series_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "planning_assignment" ADD CONSTRAINT "planning_assignment_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "planning_assignment" ADD CONSTRAINT "planning_assignment_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL: het (handmatig of via stopSeries) verwijderen van een
-- reeks mag de losse toewijzingsrijen zelf nooit meeslepen — enkel de
-- koppeling verdwijnt (business rule 15/16-analoog, vergelijkbaar met hoe
-- Project.timeTrackingMilestoneId een gearchiveerde milestone ontkoppelt
-- i.p.v. het project te raken).
ALTER TABLE "planning_assignment" ADD CONSTRAINT "planning_assignment_series_id_fkey"
    FOREIGN KEY ("series_id") REFERENCES "planning_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "planning_assignment" ADD CONSTRAINT "planning_assignment_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
