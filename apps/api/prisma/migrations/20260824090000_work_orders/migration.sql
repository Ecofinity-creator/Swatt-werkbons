-- Phase 5 — werkbonnen (basis). Handmatig geschreven, net als de vorige
-- migraties (deze ontwikkelsandbox heeft geen netwerktoegang tot Prisma's
-- engine-CDN). Exacte SQL-vertaling van prisma/schema.prisma op dit punt
-- (nieuw WorkOrderStatus-enum + work_order_counter/work_order/work_order_time_entry-tabellen).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten.

CREATE TYPE "work_order_status" AS ENUM (
    'DRAFT',
    'READY_FOR_SIGNATURE',
    'SIGNED',
    'SYNC_PENDING',
    'SYNC_FAILED',
    'READY_FOR_INVOICING',
    'INVOICED'
);

CREATE TABLE "work_order_counter" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_order_counter_pkey" PRIMARY KEY ("year")
);

CREATE TABLE "work_order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_order_number" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "work_order_status" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "created_by_employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_order_work_order_number_key" ON "work_order"("work_order_number");
CREATE INDEX "work_order_project_id_idx" ON "work_order"("project_id");
CREATE INDEX "work_order_status_idx" ON "work_order"("status");

ALTER TABLE "work_order" ADD CONSTRAINT "work_order_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "work_order" ADD CONSTRAINT "work_order_created_by_employee_id_fkey"
    FOREIGN KEY ("created_by_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "work_order_time_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_order_id" UUID NOT NULL,
    "time_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "work_order_time_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_order_time_entry_time_entry_id_key" ON "work_order_time_entry"("time_entry_id");
CREATE INDEX "work_order_time_entry_work_order_id_idx" ON "work_order_time_entry"("work_order_id");

ALTER TABLE "work_order_time_entry" ADD CONSTRAINT "work_order_time_entry_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_time_entry" ADD CONSTRAINT "work_order_time_entry_time_entry_id_fkey"
    FOREIGN KEY ("time_entry_id") REFERENCES "time_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
