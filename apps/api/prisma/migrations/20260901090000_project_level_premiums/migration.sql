-- Fase 12-herziening: toeslagen (overuren/ploegenwerk/nachtwerk) verhuizen
-- van Employee/ProjectAssignment naar Project, en gelden voortaan UNIFORM
-- voor iedereen die op dat project werkt (in plaats van per medewerker/
-- koppeling instelbaar). Reden: "de medewerker/onderaannemer wordt
-- uitbetaald volgens de afspraken met de klant" — dat is een project-
-- afspraak, geen persoonlijke instelling.
--
-- Deze migratie is voor deze drie kolommen bewust destructief (DROP COLUMN):
-- er bestaat geen zinvolle automatische 1-op-1-overzetting van "per
-- medewerker/koppeling" naar "uniform per project" wanneer meerdere
-- medewerkers op hetzelfde project potentieel verschillende percentages
-- hadden staan. Na deze migratie moet een admin de toeslagregeling per
-- project opnieuw instellen (nieuwe velden starten op de veilige defaults:
-- geen toeslag actief, 150/120/150%).
--
-- Daarnaast: Employee krijgt een nieuw, apart tarief voor uitbetaling
-- (payroll_rate_cents = kostprijs) naast het bestaande
-- default_hourly_rate_cents (dat voortaan uitsluitend de verkoopprijs/
-- facturatie-aan-klant is — ongewijzigd van betekenis, enkel de naam ernaast
-- verduidelijkt wat het nu exclusief betekent).

ALTER TABLE "employee"
    DROP COLUMN "overtime_rate_percent",
    DROP COLUMN "shift_work_rate_percent",
    DROP COLUMN "night_work_rate_percent",
    ADD COLUMN "payroll_rate_cents" INTEGER;

ALTER TABLE "project_assignment"
    DROP COLUMN "overtime_applies",
    DROP COLUMN "premium_type";

ALTER TABLE "project"
    ADD COLUMN "overtime_applies" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "premium_type" "premium_type" NOT NULL DEFAULT 'NONE',
    ADD COLUMN "overtime_rate_percent" INTEGER NOT NULL DEFAULT 150,
    ADD COLUMN "shift_work_rate_percent" INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN "night_work_rate_percent" INTEGER NOT NULL DEFAULT 150;
