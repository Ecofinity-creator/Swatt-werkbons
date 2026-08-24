-- Phase 6/7 — foto's + verplichte klanthandtekening. Handmatig geschreven,
-- net als de vorige migraties (deze ontwikkelsandbox heeft geen
-- netwerktoegang tot Prisma's engine-CDN). Exacte SQL-vertaling van
-- prisma/schema.prisma op dit punt (nieuw WorkOrderPhotoCategory-enum +
-- stored_file/work_order_photo/work_order_signature-tabellen).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten.

CREATE TYPE "work_order_photo_category" AS ENUM (
    'SITUATIE_VOOR',
    'UITVOERING',
    'SITUATIE_NA',
    'SERIENUMMER',
    'TECHNISCHE_INSTALLATIE',
    'PROBLEEM_SCHADE',
    'OVERIGE'
);

-- Generieke binaire opslag (bytea) — zie DatabaseStorageService. Bewust geen
-- FK's die hiernaar wijzen; verwijzende tabellen bewaren enkel een
-- ondoorzichtige key-string (vandaag "stored_file"."id").
CREATE TABLE "stored_file" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "stored_file_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_order_photo" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_order_id" UUID NOT NULL,
    "category" "work_order_photo_category",
    "description" TEXT,
    "optimized_file_key" TEXT NOT NULL,
    "thumbnail_file_key" TEXT NOT NULL,
    "uploaded_by_employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "work_order_photo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "work_order_photo_work_order_id_idx" ON "work_order_photo"("work_order_id");

ALTER TABLE "work_order_photo" ADD CONSTRAINT "work_order_photo_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_photo" ADD CONSTRAINT "work_order_photo_uploaded_by_employee_id_fkey"
    FOREIGN KEY ("uploaded_by_employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "work_order_signature" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_order_id" UUID NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_function" TEXT,
    "signature_file_key" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ NOT NULL,
    "ip_address" TEXT,
    "content_hash" TEXT NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "work_order_signature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_order_signature_work_order_id_key" ON "work_order_signature"("work_order_id");

ALTER TABLE "work_order_signature" ADD CONSTRAINT "work_order_signature_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_signature" ADD CONSTRAINT "work_order_signature_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
