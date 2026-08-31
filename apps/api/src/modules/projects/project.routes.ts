import type {
  ListProjectAssignmentsResponseBody,
  ListProjectsResponseBody,
  MilestoneSummary,
  MilestoneSyncResponseBody,
  ProjectSummary,
  SelectProjectMilestoneBody,
  SelectProjectMilestoneResponseBody,
  UpdateProjectAssignmentPremiumsBody,
  UpdateProjectAssignmentPremiumsResponseBody,
  UpdateProjectInvoicingEnabledBody,
  UpdateProjectInvoicingEnabledResponseBody,
  UpdateProjectOvertimeSettingsResponseBody,
  UpdateProjectSigningModeResponseBody,
} from '@swatt/shared-types';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { AuthErrors, ProjectErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';
import {
  employeeIdParamsSchema,
  listProjectsQuerySchema,
  projectAssignmentBodySchema,
  projectIdParamsSchema,
  selectProjectMilestoneBodySchema,
  updateProjectAssignmentPremiumsBodySchema,
  updateProjectInvoicingEnabledBodySchema,
  updateProjectOvertimeSettingsBodySchema,
  updateProjectSigningModeBodySchema,
} from './project.schemas';

/**
 * Phase 3 (slice): read-only toegang tot de gesynchroniseerde Teamleader-
 * projectcache, en de koppeling werknemer↔project (business rule/eis: "elke
 * gebruiker kan enkel de projecten selecteren die aan hem gekoppeld zijn").
 *
 * `POST .../project-assignments` en `.../remove` zijn bewust idempotent
 * (opnieuw koppelen/ontkoppelen van een reeds (niet-)gekoppeld project geeft
 * gewoon succes) — een dubbele klik in de UI mag nooit een foutmelding geven.
 */

/**
 * Enkel "actieve" projecten tonen in de overzichten — een gearchiveerd
 * project (`isArchivedInTl`) bestaat niet meer in Teamleader, maar een
 * niet-gearchiveerd project kan in Teamleader zelf nog steeds afgerond of
 * geannuleerd zijn (`Project.status`, puur informatief overgenomen uit
 * Teamleader — zie schema.prisma). Legacy-projecten gebruiken
 * `active/on_hold/done/cancelled`, projects-v2 gebruikt `open/closed` (zie
 * project-sync.service.ts) — dus enkel `active` resp. `open` telt hier als
 * "actief".
 */
const ACTIVE_STATUS_FILTER: Prisma.ProjectWhereInput[] = [
  { teamleaderModule: 'LEGACY', status: 'active' },
  { teamleaderModule: 'PROJECTS_V2', status: 'open' },
];

export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/projects',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<ListProjectsResponseBody> => {
      const query = listProjectsQuerySchema.parse(request.query);

      const projects = await app.prisma.project.findMany({
        where: {
          isArchivedInTl: false,
          OR: ACTIVE_STATUS_FILTER,
          ...(query.search
            ? {
                AND: [
                  {
                    OR: [
                      { name: { contains: query.search, mode: 'insensitive' } },
                      { projectNumber: { contains: query.search, mode: 'insensitive' } },
                      { address: { contains: query.search, mode: 'insensitive' } },
                      { customer: { name: { contains: query.search, mode: 'insensitive' } } },
                    ],
                  },
                ],
              }
            : {}),
        },
        include: { customer: true },
        orderBy: { name: 'asc' },
      });

      return { projects: projects.map(toProjectSummary) };
    },
  );

  // Enkel `app.authenticate` (geen requireRole): elke actieve rol mag zijn
  // eigen toegewezen projecten zien — dit is precies de "Mijn projecten"-lijst
  // uit Stap 5.1 van het fundamentendocument.
  app.get('/projects/mine', { preHandler: [app.authenticate] }, async (request): Promise<ListProjectsResponseBody> => {
    const employeeId = request.currentUser?.employee?.id;
    if (!employeeId) {
      // Kan in de praktijk niet voorkomen (elke gebruiker krijgt bij aanmaak
      // een Employee-profiel) — defensief afgehandeld i.p.v. een 500.
      throw AuthErrors.notAuthenticated();
    }

    const projects = await app.prisma.project.findMany({
      where: { isArchivedInTl: false, OR: ACTIVE_STATUS_FILTER, assignments: { some: { employeeId } } },
      include: { customer: true },
      orderBy: { name: 'asc' },
    });

    return { projects: projects.map(toProjectSummary) };
  });

  app.get(
    '/admin/employees/:employeeId/project-assignments',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<ListProjectAssignmentsResponseBody> => {
      const params = employeeIdParamsSchema.parse(request.params);
      await assertEmployeeExists(app, params.employeeId);

      const assignments = await app.prisma.projectAssignment.findMany({
        where: { employeeId: params.employeeId },
        select: { projectId: true, overtimeApplies: true, premiumType: true },
      });
      return {
        projectIds: assignments.map((assignment: { projectId: string }) => assignment.projectId),
        assignments: assignments.map((assignment: { projectId: string; overtimeApplies: boolean; premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK' }) => ({
          projectId: assignment.projectId,
          overtimeApplies: assignment.overtimeApplies,
          premiumType: assignment.premiumType,
        })),
      };
    },
  );

  app.post(
    '/admin/employees/:employeeId/project-assignments',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request, reply) => {
      const params = employeeIdParamsSchema.parse(request.params);
      const body = projectAssignmentBodySchema.parse(request.body);
      const currentUser = request.currentUser;
      if (!currentUser) {
        throw AuthErrors.notAuthenticated();
      }
      await assertEmployeeExists(app, params.employeeId);
      await assertProjectExists(app, body.projectId);

      try {
        await app.prisma.projectAssignment.create({
          data: {
            employeeId: params.employeeId,
            projectId: body.projectId,
            assignedByUserId: currentUser.id,
          },
        });
      } catch (err) {
        // P2002 = unique constraint (project_id, employee_id) — al gekoppeld:
        // idempotent, dus gewoon succes teruggeven i.p.v. een foutmelding.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }

      reply.code(204);
      return null;
    },
  );

  app.post(
    '/admin/employees/:employeeId/project-assignments/remove',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request, reply) => {
      const params = employeeIdParamsSchema.parse(request.params);
      const body = projectAssignmentBodySchema.parse(request.body);

      await app.prisma.projectAssignment.deleteMany({
        where: { employeeId: params.employeeId, projectId: body.projectId },
      });

      reply.code(204);
      return null;
    },
  );

  /**
   * Phase 9 — haalt de (legacy-)milestones van dit project op via
   * `milestones.list` en cachet ze lokaal (zie MilestoneSyncService). Bewust
   * SUPERVISOR+ (net als de projectenlijst hierboven) — een supervisor kiest
   * hier welke milestone de werkbon-uren van dit project ontvangt.
   */
  app.post(
    '/admin/projects/:id/milestones/sync',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<MilestoneSyncResponseBody> => {
      const params = projectIdParamsSchema.parse(request.params);
      const milestones = await app.milestoneSyncService.syncForProject(params.id);
      const project = await app.prisma.project.findUniqueOrThrow({ where: { id: params.id } });
      return {
        milestones: milestones.map(toMilestoneSummary),
        selectedMilestoneId: project.timeTrackingMilestoneId,
      };
    },
  );

  app.post(
    '/admin/projects/:id/milestones/select',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<SelectProjectMilestoneResponseBody> => {
      const params = projectIdParamsSchema.parse(request.params);
      const body: SelectProjectMilestoneBody = selectProjectMilestoneBodySchema.parse(request.body);
      await app.milestoneSyncService.setProjectMilestone(params.id, body.milestoneId);
      return { selectedMilestoneId: body.milestoneId };
    },
  );

  /**
   * Phase 12, deel C (sectie 3): facturatie uitschakelen per project —
   * "enkel nacalculatie". Bewust ADMIN-only (niet SUPERVISOR, in tegenstelling
   * tot de milestone-routes hierboven): dit raakt rechtstreeks of een project
   * ooit in het Facturatie-overzicht terechtkomt, en is dus een instelling met
   * financiële impact, net als de overurendrempel in deel A.
   *
   * Zet enkel de vlag zelf — de Teamleader-synchronisatie (tijd + PDF) en de
   * afgeleide WorkOrder.status-logica in sync-job.service.ts blijven
   * ongewijzigd; die laatste checkt project.invoicingEnabled vlak vóór de
   * overgang naar READY_FOR_INVOICING.
   */
  app.post(
    '/admin/projects/:id/invoicing-enabled',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<UpdateProjectInvoicingEnabledResponseBody> => {
      const params = projectIdParamsSchema.parse(request.params);
      const body: UpdateProjectInvoicingEnabledBody = updateProjectInvoicingEnabledBodySchema.parse(request.body);
      await assertProjectExists(app, params.id);

      const project = await app.prisma.project.update({
        where: { id: params.id },
        data: { invoicingEnabled: body.invoicingEnabled },
      });
      return { invoicingEnabled: project.invoicingEnabled };
    },
  );

  /**
   * Phase 12, deel A (sectie 1): overurendrempel per project — "Overuren
   * boven 8u/dag" of "Overuren boven [x]u/week". Bewust ADMIN-only, net als
   * de facturatie-instelling hierboven: dit is een instelling met directe
   * financiële impact op zowel klantfactuur (TeamleaderInvoiceService) als
   * personeelsuitbetaling (Phase 12, deel E, nog te bouwen).
   */
  app.post(
    '/admin/projects/:id/overtime-settings',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<UpdateProjectOvertimeSettingsResponseBody> => {
      const params = projectIdParamsSchema.parse(request.params);
      const body = updateProjectOvertimeSettingsBodySchema.parse(request.body);
      await assertProjectExists(app, params.id);

      const project = await app.prisma.project.update({
        where: { id: params.id },
        data: {
          overtimeThresholdType: body.overtimeThresholdType,
          // Bij DAILY bewust op null zetten (vaste 8u-drempel heeft geen
          // opgeslagen getal nodig) — voorkomt een verouderd weekgetal dat na
          // een latere terugschakeling naar WEEKLY stilzwijgend zou herleven.
          overtimeWeeklyThresholdHours: body.overtimeThresholdType === 'WEEKLY' ? (body.overtimeWeeklyThresholdHours ?? null) : null,
        },
      });
      return {
        overtimeThresholdType: project.overtimeThresholdType,
        overtimeWeeklyThresholdHours: project.overtimeWeeklyThresholdHours ? Number(project.overtimeWeeklyThresholdHours) : null,
      };
    },
  );

  /**
   * Phase 12, deel A: de toeslaginstelling van één koppeling medewerker↔project
   * (overtimeApplies + premiumType). Bewust SUPERVISOR+ — zelfde rechtenniveau
   * als de koppeling zelf (POST .../project-assignments hierboven), niet
   * ADMIN-only zoals de twee routes hierboven: dit raakt geen tarieven of
   * percentages zelf (die blijven op Employee, enkel ADMIN-instelbaar via
   * user.routes.ts), enkel *of* een toeslag van toepassing is op déze
   * koppeling.
   */
  app.post(
    '/admin/employees/:employeeId/project-assignments/premiums',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<UpdateProjectAssignmentPremiumsResponseBody> => {
      const params = employeeIdParamsSchema.parse(request.params);
      const body: UpdateProjectAssignmentPremiumsBody = updateProjectAssignmentPremiumsBodySchema.parse(request.body);
      await assertEmployeeExists(app, params.employeeId);
      await assertProjectExists(app, body.projectId);

      const existing = await app.prisma.projectAssignment.findUnique({
        where: { projectId_employeeId: { projectId: body.projectId, employeeId: params.employeeId } },
      });
      if (!existing) {
        throw ProjectErrors.notFound();
      }

      const assignment = await app.prisma.projectAssignment.update({
        where: { projectId_employeeId: { projectId: body.projectId, employeeId: params.employeeId } },
        data: { overtimeApplies: body.overtimeApplies, premiumType: body.premiumType },
      });
      return {
        assignment: { projectId: assignment.projectId, overtimeApplies: assignment.overtimeApplies, premiumType: assignment.premiumType },
      };
    },
  );

  /**
   * Phase 12, deel B (sectie 2): "Ondertekening per werkbon" of "Ondertekening
   * per week". ADMIN-only, zelfde niveau als de twee routes hierboven —
   * verandert het werkbon-goedkeuringsproces voor het hele project.
   */
  app.post(
    '/admin/projects/:id/signing-mode',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<UpdateProjectSigningModeResponseBody> => {
      const params = projectIdParamsSchema.parse(request.params);
      const body = updateProjectSigningModeBodySchema.parse(request.body);
      await assertProjectExists(app, params.id);

      const project = await app.prisma.project.update({
        where: { id: params.id },
        data: { signingMode: body.signingMode },
      });
      return { signingMode: project.signingMode };
    },
  );
}

function toMilestoneSummary(milestone: {
  id: string;
  teamleaderId: string;
  name: string;
  status: string;
  dueOn: Date | null;
  isArchivedInTl: boolean;
}): MilestoneSummary {
  return {
    id: milestone.id,
    teamleaderId: milestone.teamleaderId,
    name: milestone.name,
    status: milestone.status,
    dueOn: milestone.dueOn ? milestone.dueOn.toISOString().slice(0, 10) : null,
    isArchivedInTl: milestone.isArchivedInTl,
  };
}

async function assertEmployeeExists(app: FastifyInstance, employeeId: string): Promise<void> {
  const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) {
    throw ProjectErrors.employeeNotFound();
  }
}

async function assertProjectExists(app: FastifyInstance, projectId: string): Promise<void> {
  const project = await app.prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.isArchivedInTl) {
    throw ProjectErrors.notFound();
  }
}

// Bewust een handgeschreven structureel type i.p.v. de gegenereerde Prisma
// Project/Customer-types rechtstreeks te importeren — zelfde patroon als
// `toAuthenticatedUser` in auth/auth.service.ts.
function toProjectSummary(project: {
  id: string;
  teamleaderId: string;
  projectNumber: string | null;
  name: string;
  description: string | null;
  address: string | null;
  status: string | null;
  isArchivedInTl: boolean;
  invoicingEnabled: boolean;
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  overtimeWeeklyThresholdHours: unknown;
  signingMode: 'PER_WORK_ORDER' | 'WEEKLY';
  /** Phase 12, deel D (sectie 5) — rijafstand ÉÉN richting in meter, `null` zolang nog niet berekend. */
  kmDistanceOneWayMeters: number | null;
  customer: { name: string };
}): ProjectSummary {
  return {
    id: project.id,
    teamleaderId: project.teamleaderId,
    projectNumber: project.projectNumber,
    name: project.name,
    description: project.description,
    address: project.address,
    status: project.status,
    customerName: project.customer.name,
    isArchivedInTl: project.isArchivedInTl,
    invoicingEnabled: project.invoicingEnabled,
    overtimeThresholdType: project.overtimeThresholdType,
    // Prisma Decimal → number: dit veld is enkel een drempelgetal (bv. 39 of
    // 40), geen geldbedrag, dus een gewone JS-number is hier veilig genoeg
    // (in tegenstelling tot centbedragen elders, die altijd Int blijven).
    overtimeWeeklyThresholdHours: project.overtimeWeeklyThresholdHours === null ? null : Number(project.overtimeWeeklyThresholdHours),
    signingMode: project.signingMode,
    kmDistanceOneWayMeters: project.kmDistanceOneWayMeters,
  };
}
