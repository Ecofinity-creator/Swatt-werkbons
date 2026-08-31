import type { PrismaClient } from '@prisma/client';
import { ProjectErrors, TeamleaderErrors } from '../../errors';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from './teamleader-auth.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

/**
 * Phase 9 — legacy Teamleader-milestones (zie het uitgebreide commentaar bij
 * het Milestone-model in schema.prisma voor de volledige achtergrond: de
 * officiële `timeTracking.add`-API accepteert sinds 2019 geen `project` meer
 * als subject, enkel `milestone`). Swatt/Ecofinity's Teamleader-account
 * gebruikt de legacy-projectenmodule (bevestigd door Steven) — deze service
 * is dus wél van toepassing; voor een `projects-v2`-account bestaat geen
 * milestone-concept en wordt deze service niet aangeroepen.
 *
 * Alle velden hieronder zijn geverifieerd tegen het officiële blueprint
 * (github.com/teamleadercrm/api/blob/master/apiary.apib, sectie "Legacy
 * Milestones") — niet verzonnen.
 */

interface TeamleaderMilestoneRow {
  id: string;
  project: { type: 'project'; id: string };
  name: string;
  status: 'open' | 'closed';
  due_on: string;
}

export interface MilestoneRecord {
  id: string;
  teamleaderId: string;
  projectId: string;
  name: string;
  status: string;
  dueOn: Date | null;
  isArchivedInTl: boolean;
}

export class MilestoneSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: TeamleaderClient,
  ) {}

  /** Haalt alle (niet-)afgeronde milestones van dit project op en cachet ze lokaal (business rule 8-achtig: verdwenen milestones worden gearchiveerd, nooit hard verwijderd). */
  async syncForProject(projectId: string): Promise<MilestoneRecord[]> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }

    let rows: TeamleaderMilestoneRow[];
    try {
      rows = await this.client.listAll<TeamleaderMilestoneRow>('milestones.list', {
        filter: { project_id: project.teamleaderId },
      });
    } catch (err) {
      throw this.wrap(err);
    }

    const seenTeamleaderIds: string[] = [];
    for (const row of rows) {
      await this.prisma.milestone.upsert({
        where: { teamleaderId: row.id },
        create: {
          teamleaderId: row.id,
          projectId,
          name: row.name,
          status: row.status,
          dueOn: row.due_on ? new Date(row.due_on) : null,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
        update: {
          name: row.name,
          status: row.status,
          dueOn: row.due_on ? new Date(row.due_on) : null,
          isArchivedInTl: false,
          lastSyncedAt: new Date(),
        },
      });
      seenTeamleaderIds.push(row.id);
    }

    await this.prisma.milestone.updateMany({
      where: {
        projectId,
        isArchivedInTl: false,
        teamleaderId: { notIn: seenTeamleaderIds.length > 0 ? seenTeamleaderIds : ['__none_synced_this_run__'] },
      },
      data: { isArchivedInTl: true },
    });

    return this.prisma.milestone.findMany({ where: { projectId, isArchivedInTl: false }, orderBy: { name: 'asc' } });
  }

  /** Admin/supervisor kiest expliciet welke (al-gesynchroniseerde) milestone de werkbon-uren van dit project ontvangt. `null` heft de koppeling op. */
  async setProjectMilestone(projectId: string, milestoneId: string | null): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }
    if (milestoneId) {
      const milestone = await this.prisma.milestone.findUnique({ where: { id: milestoneId } });
      if (!milestone || milestone.projectId !== projectId) {
        throw ProjectErrors.notFound();
      }
    }
    await this.prisma.project.update({ where: { id: projectId }, data: { timeTrackingMilestoneId: milestoneId } });
  }

  /**
   * Gebruikt door TimeTrackingSyncService: geeft het Teamleader-ID van de
   * milestone terug die de uren van dit project moet ontvangen. Als er nog
   * geen (geldige) milestone gekozen is, wordt er automatisch één aangemaakt
   * via `milestones.create` — enkel mogelijk wanneer een admin een
   * `defaultMilestoneResponsibleTeamleaderUserId` heeft ingesteld (`milestones.create`
   * vereist een `responsible_user_id`; wij kunnen niet gokken wie dat moet zijn).
   */
  async resolveOrCreateTeamleaderMilestoneId(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { timeTrackingMilestone: true },
    });
    if (project.timeTrackingMilestone && !project.timeTrackingMilestone.isArchivedInTl) {
      return project.timeTrackingMilestone.teamleaderId;
    }

    const connection = await this.prisma.teamleaderConnection.findUnique({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
    });
    const responsibleUserId = connection?.defaultMilestoneResponsibleTeamleaderUserId;
    if (!responsibleUserId) {
      throw TeamleaderErrors.milestoneNotConfigured();
    }

    // Ver-in-de-toekomst placeholder-datum: dit is geen "echte" geplande
    // milestone, enkel een verzamelpunt voor werkbon-uren van dit project.
    const dueOn = new Date();
    dueOn.setFullYear(dueOn.getFullYear() + 1);
    const milestoneName = 'Werkbon-uren (Uurivo)';

    let created: { data: { id: string } };
    try {
      created = await this.client.post<{ data: { id: string } }>('milestones.create', {
        project_id: project.teamleaderId,
        name: milestoneName,
        due_on: dueOn.toISOString().slice(0, 10),
        responsible_user_id: responsibleUserId,
        billing_method: 'time_and_materials',
        // Volgens het officiële blueprint is `budget` optioneel bij
        // `time_and_materials` ("If omitted, the budget will default to
        // zero") — in de praktijk gaf Teamleader zowel bij weglaten ALS bij
        // een expliciet budget van `amount: 0` dezelfde 400 terug ("No items
        // were found for key chain budget.currency"; zie Synchronisatiefouten,
        // WB-2026-000003/000005). Vermoeden: Teamleader behandelt een budget
        // van exact nul intern anders (mogelijk als "geen budget", waarna het
        // alsnog een niet-bestaande standaardvaluta probeert op te zoeken) —
        // een klein symbolisch, niet-nul bedrag omzeilt dat. Dit is enkel een
        // verzamelpunt voor werkbon-uren, geen echte begroting; het bedrag
        // zelf is betekenisloos. EUR hardcoded: Ecofinity factureert in
        // euro's. Als dit ALSNOG dezelfde fout geeft, zit het probleem niet
        // in dit veld maar vermoedelijk in een ontbrekende standaardvaluta op
        // het Teamleader-project/-account zelf (navragen bij Teamleader-support).
        budget: { amount: 1, currency: 'EUR' },
      });
    } catch (err) {
      throw this.wrap(err);
    }

    const localMilestone = await this.prisma.milestone.create({
      data: {
        teamleaderId: created.data.id,
        projectId,
        name: milestoneName,
        status: 'open',
        dueOn,
        isArchivedInTl: false,
        lastSyncedAt: new Date(),
      },
    });
    await this.prisma.project.update({
      where: { id: projectId },
      data: { timeTrackingMilestoneId: localMilestone.id },
    });
    return localMilestone.teamleaderId;
  }

  private wrap(err: unknown): Error {
    if (err instanceof TeamleaderApiError) return TeamleaderErrors.syncFailed(err.message);
    return err instanceof Error ? TeamleaderErrors.syncFailed(err.message) : TeamleaderErrors.syncFailed('onbekende fout');
  }
}
