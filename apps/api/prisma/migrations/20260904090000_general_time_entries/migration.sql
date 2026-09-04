-- Op vraag (4/9/2026, in het kader van de Belgische verplichte urenregistratie
-- vanaf 1/1/2027): niet-projectgebonden arbeidstijd moet ook registreerbaar
-- zijn (verplaatsing, interne vergadering, opleiding, overige) — niet enkel
-- klant-facturabele projecturen. project_id wordt daarom nullable.

CREATE TYPE "time_entry_activity_type" AS ENUM ('PROJECT_WORK', 'TRAVEL', 'INTERNAL', 'TRAINING', 'OTHER');

ALTER TABLE "time_entry" ADD COLUMN "activity_type" "time_entry_activity_type" NOT NULL DEFAULT 'PROJECT_WORK';

-- project_id nullable maken: eerst de bestaande NOT NULL-constraint droppen,
-- de foreign key zelf blijft (Prisma's @relation met optionele projectId
-- vereist geen wijziging aan de FK-constraint zelf, enkel aan de kolom).
ALTER TABLE "time_entry" ALTER COLUMN "project_id" DROP NOT NULL;
