-- Klantvraag 10/9/2026: "De klant wil ook nog een mogelijkheid om de
-- gefactureerde km en uren aan te passen vooraleer de factuur naar
-- teamleader gaat."
--
-- Niet-destructief: drie nieuwe nullable kolommen op `invoice_batch_line`.
-- `null` = geen correctie, gebruik de werkelijke/bevroren waarde
-- (invoiceable_seconds resp. work_order.km_amount_cents). Enkel te wijzigen
-- zolang de batch nog DRAFT is (InvoiceBatchService.setLineAdjustment()).
ALTER TABLE "invoice_batch_line" ADD COLUMN "adjusted_invoiceable_seconds" INTEGER;
ALTER TABLE "invoice_batch_line" ADD COLUMN "adjusted_km_amount_cents" INTEGER;
ALTER TABLE "invoice_batch_line" ADD COLUMN "adjustment_note" TEXT;
