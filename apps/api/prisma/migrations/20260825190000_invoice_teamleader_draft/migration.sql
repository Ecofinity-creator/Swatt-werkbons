-- Phase 10b — "Maak conceptfactuur in Teamleader" (25 augustus 2026).
-- Handmatig geschreven, net als de vorige migraties (deze ontwikkelsandbox
-- heeft geen netwerktoegang tot Prisma's engine-CDN). Exacte SQL-vertaling
-- van prisma/schema.prisma op dit punt.
--
-- Zie claude/phase10-facturatie-onderzoek.md (project docs): Steven koos
-- "tarief per klant" (afgesproken via offerte) als uurtarief-bron, en zette
-- de invoices/departments-scopes aan op de Teamleader Marketplace-integratie.

-- Customer: uurtarief per klant (eurocent, om afrondingsfouten met floats te vermijden).
ALTER TABLE "customer" ADD COLUMN "hourly_rate_cents" INTEGER;

-- TeamleaderConnection: vaste keuzes voor invoices.draft (department_id/tax_rate_id/payment_term).
ALTER TABLE "teamleader_connection" ADD COLUMN "invoice_department_id" TEXT;
ALTER TABLE "teamleader_connection" ADD COLUMN "invoice_tax_rate_id" TEXT;
ALTER TABLE "teamleader_connection" ADD COLUMN "invoice_payment_term_type" TEXT;
ALTER TABLE "teamleader_connection" ADD COLUMN "invoice_payment_term_days" INTEGER;

-- InvoiceBatch: resultaat van de invoices.draft-aanroep. teamleader_sync_error
-- gezet ⇒ de batch bleef bewust op DRAFT staan (business rule 9) zodat een
-- admin gewoon opnieuw kan proberen zonder dat er iets lokaal verloren ging.
ALTER TABLE "invoice_batch" ADD COLUMN "teamleader_invoice_id" TEXT;
ALTER TABLE "invoice_batch" ADD COLUMN "teamleader_sync_error" TEXT;
ALTER TABLE "invoice_batch" ADD COLUMN "teamleader_submitted_at" TIMESTAMPTZ;
