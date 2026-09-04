import {
  roleAtLeast,
  type ActiveTimeEntryResponseBody,
  type ListGeneralTimeEntriesResponseBody,
  type TimeEntryResponseBody,
  type TimeEntrySummary,
} from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthErrors } from '../../errors';
import type { TimeEntryRecord } from './time-entry.service';
import { TimeEntryService } from './time-entry.service';
import {
  correctTimeEntryBodySchema,
  createManualTimeEntryBodySchema,
  startGeneralTimeEntryBodySchema,
  startTimeEntryBodySchema,
  stopTimeEntryBodySchema,
  timeEntryIdParamsSchema,
} from './time-entry.schemas';

export default async function timeEntryRoutes(app: FastifyInstance): Promise<void> {
  const service = new TimeEntryService(app.prisma);
  const auditLogService = new AuditLogService(app.prisma);

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

  /**
   * Op vraag (4/9/2026, Belgische verplichte urenregistratie vanaf 1/1/2027)
   * — zie TimeEntryService.startGeneral(). Gebruikt dezelfde PAUZE/STOP-
   * routes hieronder (die zijn al project-agnostisch, ze werken op de
   * timeEntryId zelf).
   */
  app.post('/time-entries/start-general', { preHandler: [app.authenticate] }, async (request, reply): Promise<TimeEntryResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const body = startGeneralTimeEntryBodySchema.parse(request.body);
    const entry = await service.startGeneral(employeeId, body.activityType, body.description ?? null);
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

  /**
   * Sectie 4. SUPERVISOR+, zelfde rechten als de rest van het werkbonnen-
   * beheer (zie work-order.routes.ts). Enkel toegestaan zolang de gekoppelde
   * werkbon nog DRAFT/READY_FOR_SIGNATURE is — zie TimeEntryService.correct().
   */
  app.post('/time-entries/:id/correct', { preHandler: [app.authenticate] }, async (request): Promise<TimeEntryResponseBody> => {
    const user = request.currentUser;
    if (!user || !roleAtLeast(user.role, 'SUPERVISOR')) {
      throw AuthErrors.insufficientRole();
    }
    const params = timeEntryIdParamsSchema.parse(request.params);
    const body = correctTimeEntryBodySchema.parse(request.body);

    // Op vraag (4/9/2026, in het kader van de Belgische verplichte
    // urenregistratie vanaf 1/1/2027): een manuele tijdscorrectie moet
    // auditeerbaar zijn (sectie 26 van de oorspronkelijke brief noemde dit
    // al expliciet: "tijd manueel aangepast" — nooit eerder geïnstrumenteerd).
    // Oude waarden vóór de correctie eerst ophalen zodat het auditlog een
    // zinvol oud/nieuw-verschil toont, niet enkel de nieuwe waarde.
    const before = await app.prisma.timeEntry.findUnique({
      where: { id: params.id },
      select: { startedAt: true, endedAt: true, pausedSeconds: true, description: true },
    });

    const entry = await service.correct(params.id, {
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
      pausedSeconds: body.pausedMinutes * 60,
      description: body.description ?? null,
    });

    await auditLogService.record({
      actorUserId: user.id,
      action: 'TIME_ENTRY_CORRECTED',
      entityType: 'TimeEntry',
      entityId: params.id,
      metadata: {
        before: before ? { startedAt: before.startedAt.toISOString(), endedAt: before.endedAt?.toISOString() ?? null, pausedSeconds: before.pausedSeconds } : null,
        after: { startedAt: entry.startedAt.toISOString(), endedAt: entry.endedAt?.toISOString() ?? null, pausedSeconds: entry.pausedSeconds },
      },
    });

    return { timeEntry: toSummary(entry) };
  });

  /** Op vraag (4/9/2026) — zie TimeEntryService.listGeneralForEmployee(). */
  app.get(
    '/time-entries/mine-general',
    { preHandler: [app.authenticate] },
    async (request): Promise<ListGeneralTimeEntriesResponseBody> => {
      const employeeId = requireEmployeeId(request);
      const entries = await service.listGeneralForEmployee(employeeId);
      return { timeEntries: entries.map(toSummary) };
    },
  );
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
    projectName: entry.project?.name ?? null,
    customerName: entry.project?.customer.name ?? null,
    activityType: entry.activityType,
    status: entry.status,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    pausedSeconds: entry.pausedSeconds,
    currentPauseStartedAt: entry.currentPauseStartedAt ? entry.currentPauseStartedAt.toISOString() : null,
    description: entry.description,
    isManual: entry.isManual,
  };
}
