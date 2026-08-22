-- Phase 2 — Teamleader OAuth.
-- Handmatig geschreven (net als de init-migratie): deze ontwikkelsandbox heeft
-- geen netwerktoegang tot Prisma's engine-CDN. Exacte SQL-vertaling van
-- prisma/schema.prisma op dit punt (toevoeging van TeamleaderConnection).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen (CREATE TYPE/TABLE/INDEX/CONSTRAINT slagen zonder fouten).

CREATE TYPE "teamleader_connection_status" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

CREATE TABLE "teamleader_connection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "teamleader_connection_status" NOT NULL DEFAULT 'DISCONNECTED',
    "access_token_encrypted" BYTEA,
    "refresh_token_encrypted" BYTEA,
    "token_expires_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "connected_by_user_id" UUID,
    "connected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "teamleader_connection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "teamleader_connection_connected_by_user_id_idx" ON "teamleader_connection"("connected_by_user_id");

ALTER TABLE "teamleader_connection" ADD CONSTRAINT "teamleader_connection_connected_by_user_id_fkey"
    FOREIGN KEY ("connected_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
