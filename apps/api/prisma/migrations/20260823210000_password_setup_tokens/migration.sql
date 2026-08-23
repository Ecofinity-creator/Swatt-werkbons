-- Wachtwoord-instel-/resetflow (uitnodigingsmail bij aanmaak van een nieuwe
-- gebruiker + "wachtwoord vergeten"). Handmatig geschreven, net als de vorige
-- migraties: deze ontwikkelsandbox heeft geen netwerktoegang tot Prisma's
-- engine-CDN. Exacte SQL-vertaling van prisma/schema.prisma op dit punt
-- (password_hash nullable + nieuwe password_setup_token-tabel).
-- Lokaal geverifieerd door dit bestand rechtstreeks op een schone Postgres 16
-- toe te passen, bovenop de vorige migraties, zonder fouten.

ALTER TABLE "user" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TABLE "password_setup_token" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "password_setup_token_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_setup_token_user_id_idx" ON "password_setup_token"("user_id");
CREATE INDEX "password_setup_token_expires_at_idx" ON "password_setup_token"("expires_at");

ALTER TABLE "password_setup_token" ADD CONSTRAINT "password_setup_token_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
