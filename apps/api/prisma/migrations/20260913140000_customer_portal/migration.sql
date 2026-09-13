-- Klantportaal (sectie 30, 13/9/2026): "eindklant logt in om eigen
-- werkbonnen/status te volgen" — magic-link-login per e-mailadres, geen
-- wachtwoord. Twee nieuwe tabellen, los van de bestaande medewerker-auth
-- (password_setup_token/session): een klant-token mag nooit een
-- medewerker-sessie kunnen openen of omgekeerd.

CREATE TABLE "customer_login_token" (
    "id" VARCHAR(64) NOT NULL,
    "customer_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "customer_login_token_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_login_token_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "customer_login_token_customer_id_idx" ON "customer_login_token"("customer_id");
CREATE INDEX "customer_login_token_expires_at_idx" ON "customer_login_token"("expires_at");

CREATE TABLE "customer_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "customer_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_session_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "customer_session_customer_id_idx" ON "customer_session"("customer_id");
CREATE INDEX "customer_session_expires_at_idx" ON "customer_session"("expires_at");
