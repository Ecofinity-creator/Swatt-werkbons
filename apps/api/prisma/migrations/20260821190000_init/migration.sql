-- Handmatig toegevoegd (in plaats van gegenereerd via `prisma migrate dev`):
-- de ontwikkelsandbox waarin dit project is opgezet had geen netwerktoegang
-- tot Prisma's engine-CDN, dus dit bestand is met de hand geschreven als
-- exacte SQL-vertaling van prisma/schema.prisma op dit punt (User, Employee,
-- Session). Vanaf de volgende schema-wijziging kan `prisma migrate dev`
-- gewoon gebruikt worden in elke omgeving met normale internettoegang.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE "user_role" AS ENUM ('EMPLOYEE', 'SUPERVISOR', 'ADMIN');

CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'EMPLOYEE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "teamleader_user_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
CREATE UNIQUE INDEX "user_teamleader_user_id_key" ON "user"("teamleader_user_id");
CREATE INDEX "user_role_idx" ON "user"("role");

CREATE TABLE "employee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employee_user_id_key" ON "employee"("user_id");

CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "session_user_id_idx" ON "session"("user_id");
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

ALTER TABLE "employee" ADD CONSTRAINT "employee_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
