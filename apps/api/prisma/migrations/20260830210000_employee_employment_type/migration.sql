-- Werknemer vs. Onderaannemer op de medewerkerskaart (backlog-item 30/8, zie
-- claude/projectoverdracht-samenvatting_2.md sectie 3.3). Voegt
-- employment_type toe aan employee, default EMPLOYEE zodat bestaande
-- medewerkers geen gedragswijziging ondervinden.

CREATE TYPE "employment_type" AS ENUM ('EMPLOYEE', 'SUBCONTRACTOR');

ALTER TABLE "employee" ADD COLUMN "employment_type" "employment_type" NOT NULL DEFAULT 'EMPLOYEE';
