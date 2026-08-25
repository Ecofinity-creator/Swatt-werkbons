-- Phase 10 — lokaal facturatie-overzicht (sectie 17/29). Handmatig geschreven,
-- net als de vorige migraties (deze ontwikkelsandbox heeft geen
-- netwerktoegang tot Prisma's engine-CDN). Exacte SQL-vertaling van
-- prisma/schema.prisma op dit punt.
--
-- Bewust GEEN Teamleader-koppeling hier — zie het uitgebreide commentaar
-- bij InvoiceBatch in schema.prisma en claude/phase10-facturatie-onderzoek.md
-- (project docs).

CREATE TYPE "invoice_batch_status" AS ENUM (
    'DRAFT',
    'SUBMITTED_TO_TEAMLEADER',
    'INVOICED'
);

CREATE TABLE "invoice_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "period_label" TEXT NOT NULL,
    "status" "invoice_batch_status" NOT NULL DEFAULT 'DRAFT',
    "total_invoiceable_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "invoice_batch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_batch_customer_id_idx" ON "invoice_batch"("customer_id");
CREATE INDEX "invoice_batch_period_label_idx" ON "invoice_batch"("period_label");

ALTER TABLE "invoice_batch" ADD CONSTRAINT "invoice_batch_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_batch" ADD CONSTRAINT "invoice_batch_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- InvoiceBatchLine.work_order_id is UNIQUE — de databank-afgedwongen kant van
-- business rule 7 ("een werkbon mag maar één keer gefactureerd worden"). Zie
-- het commentaar bij dit model in schema.prisma voor waarom een per-ongeluk
-- aangemaakte batch volledig verwijderd wordt (cascade) i.p.v. enkel
-- "geannuleerd".
CREATE TABLE "invoice_batch_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_batch_id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "invoiceable_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "invoice_batch_line_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_batch_line_work_order_id_key" ON "invoice_batch_line"("work_order_id");
CREATE INDEX "invoice_batch_line_invoice_batch_id_idx" ON "invoice_batch_line"("invoice_batch_id");

ALTER TABLE "invoice_batch_line" ADD CONSTRAINT "invoice_batch_line_invoice_batch_id_fkey"
    FOREIGN KEY ("invoice_batch_id") REFERENCES "invoice_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_batch_line" ADD CONSTRAINT "invoice_batch_line_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
