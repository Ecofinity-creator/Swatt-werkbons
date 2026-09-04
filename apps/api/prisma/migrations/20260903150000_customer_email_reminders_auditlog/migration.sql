-- Op vraag (3/9/2026): drie nieuwe features.
-- 1) "PDF via een knop naar de klant sturen" -> Customer.email +
--    WorkOrder.customer_email_sent_at.
-- 2) "Automatische herinnering bij een vergeten werkbon" ->
--    WorkOrder.reminder_sent_at.
-- 3) "Auditlog-scherm" -> nieuwe audit_log-tabel.

ALTER TABLE "customer" ADD COLUMN "email" TEXT;

ALTER TABLE "work_order"
    ADD COLUMN "customer_email_sent_at" TIMESTAMPTZ,
    ADD COLUMN "reminder_sent_at" TIMESTAMPTZ;

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
