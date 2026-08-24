-- Phase 8 — PDF-generatie + bedrijfsgegevens. Handmatig geschreven, net als
-- de vorige migraties (deze ontwikkelsandbox heeft geen netwerktoegang tot
-- Prisma's engine-CDN). Exacte SQL-vertaling van prisma/schema.prisma op dit
-- punt (nieuw WorkOrderPdfStatus-enum + pdf_*-kolommen op work_order +
-- nieuwe company_settings-tabel).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten.

CREATE TYPE "work_order_pdf_status" AS ENUM (
    'PDF_PENDING',
    'PDF_GENERATING',
    'PDF_READY',
    'PDF_FAILED'
);

ALTER TABLE "work_order" ADD COLUMN "pdf_status" "work_order_pdf_status" NOT NULL DEFAULT 'PDF_PENDING';
ALTER TABLE "work_order" ADD COLUMN "pdf_file_key" TEXT;
ALTER TABLE "work_order" ADD COLUMN "pdf_file_name" TEXT;
ALTER TABLE "work_order" ADD COLUMN "pdf_generated_at" TIMESTAMPTZ;
ALTER TABLE "work_order" ADD COLUMN "pdf_error" TEXT;

CREATE INDEX "work_order_pdf_status_idx" ON "work_order"("pdf_status");

-- Singleton-tabel (zie CompanySettingsService) — bewust geen seed-INSERT
-- hier, net als teamleader_connection: de service maakt de rij lazy aan
-- (upsert op een vast, welbekend ID) bij de eerste opvraging.
CREATE TABLE "company_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_name" TEXT NOT NULL,
    "address_line" TEXT,
    "vat_number" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "logo_file_key" TEXT,
    "work_order_legal_text" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);
