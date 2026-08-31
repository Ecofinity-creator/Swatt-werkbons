-- Phase 12, deel B: werkbonnen per week laten ondertekenen (sectie 2).
-- Niet-destructief: nieuwe enum/tabel/kolom met defaults die het huidige
-- gedrag (ondertekening per werkbon) ongewijzigd laten.

CREATE TYPE "signing_mode" AS ENUM ('PER_WORK_ORDER', 'WEEKLY');
CREATE TYPE "weekly_approval_status" AS ENUM ('OPEN', 'SIGNED', 'REOPENED');

ALTER TABLE "project" ADD COLUMN "signing_mode" "signing_mode" NOT NULL DEFAULT 'PER_WORK_ORDER';

CREATE TABLE "weekly_approval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "week_start_date" DATE NOT NULL,
    "week_end_date" DATE NOT NULL,
    "status" "weekly_approval_status" NOT NULL DEFAULT 'OPEN',
    "signer_name" TEXT,
    "signer_function" TEXT,
    "confirmed_at" TIMESTAMPTZ,
    "ip_address" TEXT,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "weekly_approval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_approval_project_id_week_start_date_key" ON "weekly_approval"("project_id", "week_start_date");

ALTER TABLE "weekly_approval"
    ADD CONSTRAINT "weekly_approval_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_approval"
    ADD CONSTRAINT "weekly_approval_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_order" ADD COLUMN "weekly_approval_id" UUID;
CREATE INDEX "work_order_weekly_approval_id_idx" ON "work_order"("weekly_approval_id");

ALTER TABLE "work_order"
    ADD CONSTRAINT "work_order_weekly_approval_id_fkey"
    FOREIGN KEY ("weekly_approval_id") REFERENCES "weekly_approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;
