-- Phase 3 (slice) — projectcache (customer/project) + werknemer↔project-koppeling.
-- Handmatig geschreven, net als de vorige twee migraties: deze ontwikkelsandbox
-- heeft geen netwerktoegang tot Prisma's engine-CDN. Exacte SQL-vertaling van
-- prisma/schema.prisma op dit punt (toevoeging van Customer, Project,
-- ProjectAssignment, TeamleaderProjectsModule-enum en
-- teamleader_connection.projects_module).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de twee vorige migraties, zonder fouten.

CREATE TYPE "teamleader_projects_module" AS ENUM ('LEGACY', 'PROJECTS_V2');

ALTER TABLE "teamleader_connection" ADD COLUMN "projects_module" "teamleader_projects_module";

CREATE TABLE "customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamleader_id" TEXT NOT NULL,
    "teamleader_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "vat_number" TEXT,
    "is_archived_in_tl" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_teamleader_id_key" ON "customer"("teamleader_id");

CREATE TABLE "project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamleader_id" TEXT NOT NULL,
    "teamleader_module" "teamleader_projects_module" NOT NULL,
    "customer_id" UUID NOT NULL,
    "project_number" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "status" TEXT,
    "is_archived_in_tl" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_teamleader_id_key" ON "project"("teamleader_id");
CREATE INDEX "project_customer_id_idx" ON "project"("customer_id");
CREATE INDEX "project_is_archived_in_tl_idx" ON "project"("is_archived_in_tl");

CREATE TABLE "project_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "assigned_by_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "project_assignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_assignment_project_id_employee_id_key" ON "project_assignment"("project_id", "employee_id");
CREATE INDEX "project_assignment_employee_id_idx" ON "project_assignment"("employee_id");

ALTER TABLE "project" ADD CONSTRAINT "project_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_assigned_by_user_id_fkey"
    FOREIGN KEY ("assigned_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
