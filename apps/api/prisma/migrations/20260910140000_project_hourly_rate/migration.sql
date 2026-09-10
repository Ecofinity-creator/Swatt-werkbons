-- Klantvraag 10/9/2026: "de verkoopprijs per uur voor een technieker staat nu
-- bij de technieker, maar moet verhuizen naar het project, omdat het
-- afhankelijk is per project."
--
-- 1) Nieuwe kolom `project.hourly_rate_cents` (nullable, geen default — zelfde
--    "nog niet ingesteld"-conventie als voorheen `employee.default_hourly_rate_cents`).
--    `employee.default_hourly_rate_cents` zelf blijft bestaan (niet-destructief,
--    zie het @deprecated-commentaar in schema.prisma) maar wordt nergens meer
--    gelezen om te factureren.
ALTER TABLE "project" ADD COLUMN "hourly_rate_cents" INTEGER;

-- 2) `invoice_batch_employee_rate` (eenmalige factuurbatch-override per
--    medewerker) vervangen door `invoice_batch_project_rate` (per project) —
--    de override volgt de verhuizing van de verkoopprijs zelf. De oude tabel
--    bevatte enkel kortstondige, per-factuur hulpwaarden (geen definitieve
--    financiële vastlegging: dat gebeurt pas bij de Teamleader-conceptfactuur
--    zelf) — die verliezen hun betekenis zodra de prijsbron verandert, dus
--    hier bewust een schone vervanging i.p.v. een datamigratie.
DROP TABLE IF EXISTS "invoice_batch_employee_rate";

CREATE TABLE "invoice_batch_project_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_batch_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "hourly_rate_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "invoice_batch_project_rate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_batch_project_rate_invoice_batch_id_project_id_key"
    ON "invoice_batch_project_rate"("invoice_batch_id", "project_id");

ALTER TABLE "invoice_batch_project_rate"
    ADD CONSTRAINT "invoice_batch_project_rate_invoice_batch_id_fkey"
    FOREIGN KEY ("invoice_batch_id") REFERENCES "invoice_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_batch_project_rate"
    ADD CONSTRAINT "invoice_batch_project_rate_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
