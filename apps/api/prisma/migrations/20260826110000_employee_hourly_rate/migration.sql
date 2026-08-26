-- Facturatie: tarief per medewerker i.p.v. per klant.
-- Voegt Employee.default_hourly_rate_cents toe (standaardtarief, in te stellen
-- bij "Medewerkers") en de tabel invoice_batch_employee_rate (eenmalige
-- override per factuurbatch, voor medewerkers zonder standaardtarief).

ALTER TABLE "employee" ADD COLUMN "default_hourly_rate_cents" INTEGER;

CREATE TABLE "invoice_batch_employee_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_batch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "hourly_rate_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "invoice_batch_employee_rate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_batch_employee_rate_invoice_batch_id_employee_id_key"
    ON "invoice_batch_employee_rate"("invoice_batch_id", "employee_id");

ALTER TABLE "invoice_batch_employee_rate"
    ADD CONSTRAINT "invoice_batch_employee_rate_invoice_batch_id_fkey"
    FOREIGN KEY ("invoice_batch_id") REFERENCES "invoice_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_batch_employee_rate"
    ADD CONSTRAINT "invoice_batch_employee_rate_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
