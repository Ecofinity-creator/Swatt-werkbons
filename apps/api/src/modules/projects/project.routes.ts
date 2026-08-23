import type {
  ListProjectAssignmentsResponseBody,
  ListProjectsResponseBody,
  ProjectSummary,
} from '@swatt/shared-types';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { AuthErrors, ProjectErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';
import { employeeIdParamsSchema, listProjectsQuerySchema, projectAssignmentBodySchema } from './project.schemas';

/**
 * Phase 3 (slice): read-only toegang tot de gesynchroniseerde Teamleader-
 * projectcache, en de koppeling werknemer↔project (business rule/eis: "elke
 * gebruiker kan enkel de projecten selecteren die aan hem gekoppeld zijn").
 *
 * `POST .../project-assignments` en `.../remove` zijn bewust idempotent
 * (opnieuw koppelen/ontkoppelen van een reeds (niet-)gekoppeld project geeft
 * gewoon succes) — een dubbele klik in de UI mag nooit een foutmelding geven.
 */
export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/projects',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<ListProjectsResponseBody> => {
      const query = listProjectsQuerySchema.parse(request.query);

      const projects = await app.prisma.project.findMany({
        where: {
          isArchivedInTl: false,
          ...(query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { projectNumber: { contains: query.search, mode: 'insensitive' } },
                  { address: { contains: query.search, mode: 'insensitive' } },
                  { customer: { name: { contains: query.search, mode: 'insensitive' } } },
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
      where: { isArchivedInTl: false, assignments: { some: { employeeId } } },
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
        select: { projectId: true },
      });
      return { projectIds: assignments.map((assignment: { projectId: string }) => assignment.projectId) };
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
  };
}
