-- Phase 12, deel A: toeslagen (overuren/ploegenwerk/nachtwerk) + overurendrempel per project.
-- Niet-destructief: enkel nieuwe enums/kolommen met defaults die het huidige
-- gedrag ongewijzigd laten (overtimeApplies=false, premiumType=NONE ->
-- de nieuwe factuurregel-splitsing levert exact hetzelfde resultaat op als
-- vandaag zolang niemand deze instellingen aanvinkt).

CREATE TYPE "premium_type" AS ENUM ('NONE', 'SHIFT_WORK', 'NIGHT_WORK');
CREATE TYPE "overtime_threshold_type" AS ENUM ('DAILY', 'WEEKLY');

ALTER TABLE "employee"
    ADD COLUMN "overtime_rate_percent" INTEGER NOT NULL DEFAULT 150,
    ADD COLUMN "shift_work_rate_percent" INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN "night_work_rate_percent" INTEGER NOT NULL DEFAULT 150;

ALTER TABLE "project_assignment"
    ADD COLUMN "overtime_applies" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "premium_type" "premium_type" NOT NULL DEFAULT 'NONE';

ALTER TABLE "project"
    ADD COLUMN "overtime_threshold_type" "overtime_threshold_type" NOT NULL DEFAULT 'DAILY',
    ADD COLUMN "overtime_weekly_threshold_hours" DECIMAL(4, 2);
