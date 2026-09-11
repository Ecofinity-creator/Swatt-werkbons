import type {
  ClearPlanningAssignmentBody,
  CreatePlanningAssignmentBody,
  CreatePlanningAssignmentResponseBody,
  CreatePlanningSeriesBody,
  CreatePlanningSeriesResponseBody,
  ListMyPlanningResponseBody,
  ListPlanningEmployeesResponseBody,
  ListPlanningSeriesResponseBody,
  ListPlanningWeekResponseBody,
  PlanningAssignmentSummary,
  PlanningEmployeeSummary,
  PlanningSeriesSummary,
} from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors } from '../../errors';
import { requireRole } from '../rbac/rbac.middleware';
import {
  clearPlanningAssignmentBodySchema,
  createPlanningAssignmentBodySchema,
  createPlanningSeriesBodySchema,
  planningMineQuerySchema,
  planningSeriesIdParamsSchema,
  planningWeekQuerySchema,
} from './planning.schemas';
import { formatDateOnly, parseDateOnly, PlanningService } from './planning.service';
import type { PlanningAssignmentRecord, PlanningEmployeeRecord, PlanningSeriesRecord } from './planning.service';

/**
 * Fase 13 (concept) — planningsmodule/dispatch. SUPERVISOR+ plant
 * (`/admin/planning/...`, zelfde rechtenniveau als "werknemers aan projecten
 * koppelen", projectbrief §4); elke ingelogde gebruiker mag enkel zijn eigen
 * toewijzingen inkijken (`/planning/mine`, zie EmployeeProjectsPage.tsx —
 * "Mijn planning", klantvraag 10/9/2026). Bewust geen wijzigingsrechten voor
 * de medewerker zelf.
 *
 * Puur lokaal — raakt geen enkele Teamleader-endpoint (het project/de
 * medewerker zelf komt al uit de bestaande sync, dit is enkel een lokale
 * datum-koppeling erbovenop).
 */
export default async function planningRoutes(app: FastifyInstance): Promise<void> {
  const service = new PlanningService(app.prisma);

  app.get(
    '/admin/planning/employees',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (): Promise<ListPlanningEmployeesResponseBody> => {
      const employees = await service.listEmployees();
      return { employees: employees.map(toEmployeeSummary) };
    },
  );

  app.get(
    '/admin/planning/week',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<ListPlanningWeekResponseBody> => {
      const query = planningWeekQuerySchema.parse(request.query);
      const assignments = await service.listWeek(query.weekStart);
      return { assignments: assignments.map(toAssignmentSummary) };
    },
  );

  app.get(
    '/admin/planning/series',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (): Promise<ListPlanningSeriesResponseBody> => {
      const series = await service.listActiveSeries();
      return { series: series.map(toSeriesSummary) };
    },
  );

  app.post(
    '/admin/planning/assignments',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request): Promise<CreatePlanningAssignmentResponseBody> => {
      const body: CreatePlanningAssignmentBody = createPlanningAssignmentBodySchema.parse(request.body);
      const currentUser = requireCurrentUser(request);
      const assignment = await service.setAssignment({ ...body, createdById: currentUser.id });
      return { assignment: toAssignmentSummary(assignment) };
    },
  );

  app.post(
    '/admin/planning/assignments/clear',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request, reply) => {
      const body: ClearPlanningAssignmentBody = clearPlanningAssignmentBodySchema.parse(request.body);
      await service.clearAssignment(body);
      reply.code(204);
      return null;
    },
  );

  app.post(
    '/admin/planning/series',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request, reply): Promise<CreatePlanningSeriesResponseBody> => {
      const body: CreatePlanningSeriesBody = createPlanningSeriesBodySchema.parse(request.body);
      const currentUser = requireCurrentUser(request);
      const { series, generatedCount } = await service.createSeries({ ...body, createdById: currentUser.id });
      reply.code(201);
      return { series: toSeriesSummary(series), generatedCount };
    },
  );

  app.post(
    '/admin/planning/series/:id/stop',
    { preHandler: [app.authenticate, requireRole('SUPERVISOR')] },
    async (request, reply) => {
      const params = planningSeriesIdParamsSchema.parse(request.params);
      await service.stopSeries(params.id);
      reply.code(204);
      return null;
    },
  );

  // Enkel `app.authenticate` (geen requireRole): elke actieve rol mag zijn
  // eigen aankomende planning inkijken — zelfde patroon als /projects/mine.
  app.get('/planning/mine', { preHandler: [app.authenticate] }, async (request): Promise<ListMyPlanningResponseBody> => {
    const employeeId = request.currentUser?.employee?.id;
    if (!employeeId) {
      throw AuthErrors.notAuthenticated();
    }
    const query = planningMineQuerySchema.parse(request.query);
    // Klantvraag 11/9/2026: bij voorkeur de telefoon zijn eigen lokale
    // "vandaag" laten meesturen i.p.v. hier de systeemklok van de server
    // (UTC) te gebruiken — zie de toelichting bij `today` in
    // planning.schemas.ts en `listForEmployee` in planning.service.ts.
    const referenceDate = query.today ? parseDateOnly(query.today) : undefined;
    const assignments = await service.listForEmployee(employeeId, query.days, referenceDate);
    return { assignments: assignments.map(toAssignmentSummary) };
  });
}

function requireCurrentUser(request: FastifyRequest): NonNullable<FastifyRequest['currentUser']> {
  const currentUser = request.currentUser;
  if (!currentUser) {
    throw AuthErrors.notAuthenticated();
  }
  return currentUser;
}

function toEmployeeSummary(employee: PlanningEmployeeRecord): PlanningEmployeeSummary {
  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    employmentType: employee.employmentType,
  };
}

function toAssignmentSummary(assignment: PlanningAssignmentRecord): PlanningAssignmentSummary {
  return {
    id: assignment.id,
    employeeId: assignment.employeeId,
    employeeDisplayName: assignment.employee.displayName,
    projectId: assignment.projectId,
    projectName: assignment.project.name,
    customerName: assignment.project.customer.name,
    date: formatDateOnly(assignment.date),
    seriesId: assignment.seriesId,
  };
}

function toSeriesSummary(series: PlanningSeriesRecord): PlanningSeriesSummary {
  return {
    id: series.id,
    employeeId: series.employeeId,
    employeeDisplayName: series.employee.displayName,
    projectId: series.projectId,
    projectName: series.project.name,
    customerName: series.project.customer.name,
    weekdays: series.weekdays,
    startDate: formatDateOnly(series.startDate),
    endDate: formatDateOnly(series.endDate),
    active: series.active,
  };
}
