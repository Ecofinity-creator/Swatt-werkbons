-- Phase 9 — Teamleader-sync: tijdregistratie (milestone-gebaseerd, want
-- legacy-projectenmodule — zie het uitgebreide commentaar bij Milestone in
-- schema.prisma) + PDF-upload + SyncJob/SyncLog. Handmatig geschreven, net
-- als de vorige migraties (deze ontwikkelsandbox heeft geen netwerktoegang
-- tot Prisma's engine-CDN). Exacte SQL-vertaling van prisma/schema.prisma op
-- dit punt.
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten, inclusief een
-- end-to-end insert/query-test (zie PR-beschrijving/testprocedure).

CREATE TYPE "work_order_teamleader_upload_status" AS ENUM (
    'TEAMLEADER_UPLOAD_PENDING',
    'TEAMLEADER_UPLOADED',
    'TEAMLEADER_UPLOAD_FAILED'
);

CREATE TYPE "time_entry_sync_status" AS ENUM (
    'NOT_SYNCED',
    'PENDING',
    'SYNCED',
    'FAILED'
);

CREATE TYPE "sync_job_type" AS ENUM (
    'TIME_ENTRIES',
    'PDF_UPLOAD'
);

CREATE TYPE "sync_job_status" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED'
);

CREATE TYPE "sync_log_status" AS ENUM (
    'STARTED',
    'SUCCEEDED',
    'FAILED'
);

-- TeamleaderConnection: verantwoordelijke gebruiker voor automatisch
-- aangemaakte milestones (zie schema.prisma-commentaar bij dit veld).
ALTER TABLE "teamleader_connection" ADD COLUMN "default_milestone_responsible_teamleader_user_id" TEXT;

-- Milestone-cache (moet vóór de FK op project.time_tracking_milestone_id bestaan).
CREATE TABLE "milestone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamleader_id" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "due_on" DATE,
    "is_archived_in_tl" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "milestone_teamleader_id_key" ON "milestone"("teamleader_id");
CREATE INDEX "milestone_project_id_idx" ON "milestone"("project_id");

ALTER TABLE "milestone" ADD CONSTRAINT "milestone_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Project: gekozen/aangemaakte "werkbon-uren"-milestone (nullable, aparte
-- benoemde relatie t.o.v. de gewone milestone.project_id-relatie hierboven).
ALTER TABLE "project" ADD COLUMN "time_tracking_milestone_id" UUID;

CREATE INDEX "project_time_tracking_milestone_id_idx" ON "project"("time_tracking_milestone_id");

ALTER TABLE "project" ADD CONSTRAINT "project_time_tracking_milestone_id_fkey"
    FOREIGN KEY ("time_tracking_milestone_id") REFERENCES "milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- TimeEntry: sync-status naar Teamleader (sectie 14).
ALTER TABLE "time_entry" ADD COLUMN "sync_status" "time_entry_sync_status" NOT NULL DEFAULT 'NOT_SYNCED';
ALTER TABLE "time_entry" ADD COLUMN "teamleader_time_tracking_id" TEXT;
ALTER TABLE "time_entry" ADD COLUMN "synced_at" TIMESTAMPTZ;
ALTER TABLE "time_entry" ADD COLUMN "sync_payload_hash" TEXT;
ALTER TABLE "time_entry" ADD COLUMN "sync_error" TEXT;

CREATE UNIQUE INDEX "time_entry_teamleader_time_tracking_id_key" ON "time_entry"("teamleader_time_tracking_id");
CREATE INDEX "time_entry_sync_status_idx" ON "time_entry"("sync_status");

-- WorkOrder: upload-status van de (Phase 8-)PDF naar Teamleader (sectie 13).
ALTER TABLE "work_order" ADD COLUMN "teamleader_upload_status" "work_order_teamleader_upload_status" NOT NULL DEFAULT 'TEAMLEADER_UPLOAD_PENDING';
ALTER TABLE "work_order" ADD COLUMN "teamleader_file_id" TEXT;
ALTER TABLE "work_order" ADD COLUMN "teamleader_uploaded_at" TIMESTAMPTZ;
ALTER TABLE "work_order" ADD COLUMN "teamleader_upload_error" TEXT;

CREATE INDEX "work_order_teamleader_upload_status_idx" ON "work_order"("teamleader_upload_status");

-- SyncJob: durable achtergrondwerk-status per (werkbon, syncsoort) — zie schema.prisma-commentaar.
CREATE TABLE "sync_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_order_id" UUID NOT NULL,
    "type" "sync_job_type" NOT NULL,
    "status" "sync_job_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempted_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sync_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sync_job_work_order_id_type_key" ON "sync_job"("work_order_id", "type");
CREATE INDEX "sync_job_status_idx" ON "sync_job"("status");

ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SyncLog: append-only audittrail per sync-poging (sectie 23/26).
CREATE TABLE "sync_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sync_job_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "sync_log_status" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_log_sync_job_id_idx" ON "sync_log"("sync_job_id");

ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_sync_job_id_fkey"
    FOREIGN KEY ("sync_job_id") REFERENCES "sync_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
