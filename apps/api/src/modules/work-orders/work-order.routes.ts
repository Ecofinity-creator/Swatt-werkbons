import { roleAtLeast, type WorkOrderPhotoSummary, type WorkOrderResponseBody, type WorkOrderSummary } from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors, WorkOrderErrors } from '../../errors';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import type { WorkOrderPhotoRecord, WorkOrderRecord } from './work-order.service';
import { WorkOrderService } from './work-order.service';
import { WorkOrderPhotoService } from './work-order-photo.service';
import { WorkOrderSignatureService } from './work-order-signature.service';
import {
  addWorkOrderPhotoBodySchema,
  createWorkOrderBodySchema,
  signWorkOrderBodySchema,
  workOrderIdParamsSchema,
  workOrderPhotoParamsSchema,
} from './work-order.schemas';

// Body-limieten hierboven op Fastify's default van 1MB (zie app.ts voor de
// nette 413-foutmelding bij FST_ERR_CTP_BODY_TOO_LARGE). Ruim boven de
// zod-groottelimieten in work-order.schemas.ts (base64 is ~1,33x de ruwe
// bytegrootte) zodat een geldige upload nooit op de HTTP-laag sneuvelt vóór
// de eigen, mensentaal-foutmelding van zod kan triggeren.
const ADD_PHOTO_BODY_LIMIT = 12 * 1024 * 1024;
const SIGN_BODY_LIMIT = 5 * 1024 * 1024;

export default async function workOrderRoutes(app: FastifyInstance): Promise<void> {
  const service = new WorkOrderService(app.prisma);
  const storage: StorageService = new DatabaseStorageService(app.prisma);
  const photoService = new WorkOrderPhotoService(app.prisma, storage);
  const signatureService = new WorkOrderSignatureService(app.prisma, storage);

  app.post('/work-orders', { preHandler: [app.authenticate] }, async (request, reply): Promise<WorkOrderResponseBody> => {
    const employeeId = requireEmployeeId(request);
    const body = createWorkOrderBodySchema.parse(request.body);
    const workOrder = await service.create(employeeId, body.projectId, body.timeEntryIds, body.description ?? null);
    reply.code(201);
    return { workOrder: await toSummary(storage, workOrder) };
  });

  app.get('/work-orders/:id', { preHandler: [app.authenticate] }, async (request): Promise<WorkOrderResponseBody> => {
    const params = workOrderIdParamsSchema.parse(request.params);
    const workOrder = await service.get(params.id);
    requireWorkOrderAccess(request, workOrder);
    return { workOrder: await toSummary(storage, workOrder) };
  });

  app.post(
    '/work-orders/:id/photos',
    { preHandler: [app.authenticate], bodyLimit: ADD_PHOTO_BODY_LIMIT },
    async (request, reply): Promise<WorkOrderResponseBody> => {
      const employeeId = requireEmployeeId(request);
      const params = workOrderIdParamsSchema.parse(request.params);
      const body = addWorkOrderPhotoBodySchema.parse(request.body);

      await photoService.add(employeeId, params.id, {
        category: body.category ?? null,
        description: body.description ?? null,
        optimized: { data: Buffer.from(body.optimizedDataBase64, 'base64'), mimeType: body.optimizedMimeType },
        thumbnail: { data: Buffer.from(body.thumbnailDataBase64, 'base64'), mimeType: body.thumbnailMimeType },
      });

      const workOrder = await service.get(params.id);
      reply.code(201);
      return { workOrder: await toSummary(storage, workOrder) };
    },
  );

  app.post(
    '/work-orders/:id/photos/:photoId/remove',
    { preHandler: [app.authenticate] },
    async (request): Promise<WorkOrderResponseBody> => {
      const employeeId = requireEmployeeId(request);
      const params = workOrderPhotoParamsSchema.parse(request.params);

      await photoService.remove(employeeId, params.id, params.photoId);

      const workOrder = await service.get(params.id);
      return { workOrder: await toSummary(storage, workOrder) };
    },
  );

  app.post(
    '/work-orders/:id/sign',
    { preHandler: [app.authenticate], bodyLimit: SIGN_BODY_LIMIT },
    async (request, reply): Promise<WorkOrderResponseBody> => {
      const employeeId = requireEmployeeId(request);
      const params = workOrderIdParamsSchema.parse(request.params);
      const body = signWorkOrderBodySchema.parse(request.body);
      const userId = request.currentUser?.id;
      if (!userId) {
        throw AuthErrors.notAuthenticated();
      }

      await signatureService.sign(employeeId, params.id, {
        signerName: body.signerName,
        signerFunction: body.signerFunction ?? null,
        requestedByUserId: userId,
        ipAddress: request.ip ?? null,
        image: { data: Buffer.from(body.signatureDataBase64, 'base64'), mimeType: body.mimeType },
      });

      const workOrder = await service.get(params.id);
      reply.code(201);
      return { workOrder: await toSummary(storage, workOrder) };
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

async function toPhotoSummary(storage: StorageService, photo: WorkOrderPhotoRecord): Promise<WorkOrderPhotoSummary> {
  const [optimized, thumbnail] = await Promise.all([
    storage.read(photo.optimizedFileKey),
    storage.read(photo.thumbnailFileKey),
  ]);
  return {
    id: photo.id,
    category: (photo.category as WorkOrderPhotoSummary['category']) ?? null,
    description: photo.description,
    optimizedDataUrl: toDataUrl(optimized.mimeType, optimized.data),
    thumbnailDataUrl: toDataUrl(thumbnail.mimeType, thumbnail.data),
    uploadedByEmployeeDisplayName: photo.uploadedByEmployee.displayName,
    createdAt: photo.createdAt.toISOString(),
  };
}

async function toSummary(storage: StorageService, workOrder: WorkOrderRecord): Promise<WorkOrderSummary> {
  const photos = await Promise.all(workOrder.photos.map((photo) => toPhotoSummary(storage, photo)));

  let signature: WorkOrderSummary['signature'] = null;
  if (workOrder.signature) {
    const image = await storage.read(workOrder.signature.signatureFileKey);
    signature = {
      signerName: workOrder.signature.signerName,
      signerFunction: workOrder.signature.signerFunction,
      signedAt: workOrder.signature.signedAt.toISOString(),
      imageDataUrl: toDataUrl(image.mimeType, image.data),
    };
  }

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
    photos,
    signature,
  };
}

function toDataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}
