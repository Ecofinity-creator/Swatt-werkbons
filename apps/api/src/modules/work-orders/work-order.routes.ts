import { roleAtLeast, type WorkOrderResponseBody, type WorkOrderSummary } from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors, WorkOrderErrors } from '../../errors';
import type { WorkOrderRecord } from './work-order.service';
import { WorkOrderService } from './work-order.service';
import { createWorkOrderBodySchema, workOrderIdParamsSchema } from './work-order.schemas';

export default async function workOrderRoutes(app: FastifyInstance): Promise<void> {
  const service = new WorkOrderService(app.prisma);

  app.post('/work-orders', { preHandler: [app.authenticate] }, async (request, reply): Promise<WorkOrderResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const body = createWorkOrderBodySchema.parse(request.body);
    const workOrder = await service.create(employeeId, body.projectId, body.timeEntryIds, body.description ?? null);
    reply.code(201);
    return { workOrder: toSummary(workOrder) };
  });

  app.get('/work-orders/:id', { preHandler: [app.authenticate] }, async (request): Promise<WorkOrderResponseBody> => {
    const params = workOrderIdParamsSchema.parse(request.params);
    const workOrder = await service.get(params.id);
    requireWorkOrderAccess(request, workOrder);
    return { workOrder: toSummary(workOrder) };
  });
}

function requireEmployeeId(request: FastifyRequest): string {
  const employeeId = request.currentUser?.employee?.id;
  if (!employeeId) {
    throw AuthErrors.notAuthenticated();
  }
  return employeeId;
}

/**
 * SUPERVISOR/ADMIN zien alle werkbonnen (sectie 4). Een EMPLOYEE mag enkel
 * werkbonnen zien die hij zelf aanmaakte of waar hij als tijdsregistratie in
 * voorkomt — bij een niet-toegelaten werkbon geven we dezelfde NOT_FOUND-fout
 * als bij een onbestaande werkbon (zelfde anti-enumeratie-patroon als
 * TimeEntryService.findOwnedEntry), zodat het bestaan van andermans werkbon
 * niet lekt.
 */
function requireWorkOrderAccess(request: FastifyRequest, workOrder: WorkOrderRecord): void {
  const user = request.currentUser;
  if (!user) {
    throw AuthErrors.notAuthenticated();
  }
  if (roleAtLeast(user.role, 'SUPERVISOR')) {
    return;
  }
  const employeeId = user.employee?.id;
  const isParticipant =
    employeeId != null &&
    (workOrder.createdByEmployeeId === employeeId ||
      workOrder.timeEntries.some((link) => link.timeEntry.employeeId === employeeId));
  if (!isParticipant) {
    throw WorkOrderErrors.notFound();
  }
}

function toSummary(workOrder: WorkOrderRecord): WorkOrderSummary {
  return {
    id: workOrder.id,
    workOrderNumber: workOrder.workOrderNumber,
    projectId: workOrder.projectId,
    projectName: workOrder.project.name,
    customerName: workOrder.project.customer.name,
    status: workOrder.status,
    description: workOrder.description,
    createdByEmployeeDisplayName: workOrder.createdByEmployee.displayName,
    createdAt: workOrder.createdAt.toISOString(),
    timeEntries: workOrder.timeEntries.map((link) => ({
      id: link.timeEntry.id,
      employeeId: link.timeEntry.employeeId,
      employeeDisplayName: link.timeEntry.employee.displayName,
      startedAt: link.timeEntry.startedAt.toISOString(),
      endedAt: link.timeEntry.endedAt ? link.timeEntry.endedAt.toISOString() : null,
      pausedSeconds: link.timeEntry.pausedSeconds,
    })),
  };
}
