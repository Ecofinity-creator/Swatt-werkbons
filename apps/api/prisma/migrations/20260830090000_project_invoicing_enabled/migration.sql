-- Phase 12, deel C: facturatie uitschakelen per project (nacalculatie).
-- Niet-destructief: nieuwe kolom met default true, bestaand gedrag blijft
-- ongewijzigd voor alle bestaande projecten. Enkel het lokale
-- Facturatie-overzicht (InvoiceBatchService.listInvoiceable()) filtert
-- voortaan op deze vlag; de Teamleader-synchronisatie zelf (uren + PDF)
-- blijft ongewijzigd lopen, ook wanneer invoicing_enabled = false.
ALTER TABLE "project" ADD COLUMN "invoicing_enabled" BOOLEAN NOT NULL DEFAULT true;
