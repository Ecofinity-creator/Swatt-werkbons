-- Phase 12, deel E: personeelsuitbetaling (maandoverzicht per medewerker).
-- Volledig nieuwe tabellen, geen wijziging aan bestaande data.

CREATE TYPE "payroll_batch_status" AS ENUM ('DRAFT', 'CLOSED');

CREATE TABLE "payroll_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "period_label" TEXT NOT NULL,
    "status" "payroll_batch_status" NOT NULL DEFAULT 'DRAFT',
    "total_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "payroll_batch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payroll_batch_employee_id_idx" ON "payroll_batch"("employee_id");
CREATE INDEX "payroll_batch_period_label_idx" ON "payroll_batch"("period_label");

ALTER TABLE "payroll_batch"
    ADD CONSTRAINT "payroll_batch_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payroll_batch"
    ADD CONSTRAINT "payroll_batch_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payroll_batch_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payroll_batch_id" UUID NOT NULL,
    "time_entry_id" UUID NOT NULL,
    "normal_hours" DECIMAL(6, 2) NOT NULL,
    "overtime_hours" DECIMAL(6, 2) NOT NULL,
    "premium_type" "premium_type" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "payroll_batch_line_pkey" PRIMARY KEY ("id")
);

-- Business rule 12: elke tijdregistratie mag maar één keer uitbetaald worden.
CREATE UNIQUE INDEX "payroll_batch_line_time_entry_id_key" ON "payroll_batch_line"("time_entry_id");
CREATE INDEX "payroll_batch_line_payroll_batch_id_idx" ON "payroll_batch_line"("payroll_batch_id");

ALTER TABLE "payroll_batch_line"
    ADD CONSTRAINT "payroll_batch_line_payroll_batch_id_fkey"
    FOREIGN KEY ("payroll_batch_id") REFERENCES "payroll_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payroll_batch_line"
    ADD CONSTRAINT "payroll_batch_line_time_entry_id_fkey"
    FOREIGN KEY ("time_entry_id") REFERENCES "time_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
