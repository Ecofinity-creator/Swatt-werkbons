import type {
  ActiveTimeEntryResponseBody,
  TimeEntryResponseBody,
  TimeEntrySummary,
} from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors } from '../../errors';
import type { TimeEntryRecord } from './time-entry.service';
import { TimeEntryService } from './time-entry.service';
import {
  createManualTimeEntryBodySchema,
  startTimeEntryBodySchema,
  stopTimeEntryBodySchema,
  timeEntryIdParamsSchema,
} from './time-entry.schemas';

export default async function timeEntryRoutes(app: FastifyInstance): Promise<void> {
  const service = new TimeEntryService(app.prisma);

  app.get('/time-entries/active', { preHandler: [app.authenticate] }, async (request): Promise<ActiveTimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const entry = await service.getActive(employeeId);
    return { timeEntry: entry ? toSummary(entry) : null };
  });

  app.post('/time-entries/start', { preHandler: [app.authenticate] }, async (request, reply): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const body = startTimeEntryBodySchema.parse(request.body);
    const entry = await service.start(employeeId, body.projectId);
    reply.code(201);
    return { timeEntry: toSummary(entry) };
  });

  app.post('/time-entries/manual', { preHandler: [app.authenticate] }, async (request, reply): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const body = createManualTimeEntryBodySchema.parse(request.body);
    const entry = await service.createManual(employeeId, {
      projectId: body.projectId,
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
      pausedSeconds: (body.pausedMinutes ?? 0) * 60,
      description: body.description ?? null,
    });
    reply.code(201);
    return { timeEntry: toSummary(entry) };
  });

  app.post('/time-entries/:id/pause', { preHandler: [app.authenticate] }, async (request): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const params = timeEntryIdParamsSchema.parse(request.params);
    const entry = await service.pause(employeeId, params.id);
    return { timeEntry: toSummary(entry) };
  });

  app.post('/time-entries/:id/resume', { preHandler: [app.authenticate] }, async (request): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const params = timeEntryIdParamsSchema.parse(request.params);
    const entry = await service.resume(employeeId, params.id);
    return { timeEntry: toSummary(entry) };
  });

  app.post('/time-entries/:id/stop', { preHandler: [app.authenticate] }, async (request): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const params = timeEntryIdParamsSchema.parse(request.params);
    const body = stopTimeEntryBodySchema.parse(request.body ?? {});
    const entry = await service.stop(employeeId, params.id, body.description ?? null);
    return { timeEntry: toSummary(entry) };
  });
}

function requireEmployeeId(request: FastifyRequest): string {
  const employeeId = request.currentUser?.employee?.id;
  if (!employeeId) {
    throw AuthErrors.notAuthenticated();
  }
  return employeeId;
}

function toSummary(entry: TimeEntryRecord): TimeEntrySummary {
  return {
    id: entry.id,
    projectId: entry.projectId,
    projectName: entry.project.name,
    customerName: entry.project.customer.name,
    status: entry.status,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    pausedSeconds: entry.pausedSeconds,
    currentPauseStartedAt: entry.currentPauseStartedAt ? entry.currentPauseStartedAt.toISOString() : null,
    description: entry.description,
    isManual: entry.isManual,
  };
}
