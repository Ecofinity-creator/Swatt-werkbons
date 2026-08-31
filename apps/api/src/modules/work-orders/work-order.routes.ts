import {
  roleAtLeast,
  type ListWorkOrderSyncIssuesResponseBody,
  type WorkOrderPhotoSummary,
  type WorkOrderResponseBody,
  type WorkOrderSummary,
  type WorkOrderSyncIssueSummary,
} from '@swatt/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthErrors, WorkOrderErrors } from '../../errors';
import { CompanySettingsService } from '../company-settings/company-settings.service';
import { DatabaseStorageService, type StorageService } from '../storage/storage.service';
import type { WorkOrderPhotoRecord, WorkOrderRecord } from './work-order.service';
import { WorkOrderService, deriveTimeTrackingSyncError, deriveTimeTrackingSyncStatus } from './work-order.service';
import { WorkOrderPdfService } from './work-order-pdf.service';
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
  const companySettingsService = new CompanySettingsService(app.prisma);
  const signatureService = new WorkOrderSignatureService(app.prisma, storage, companySettingsService);
  const pdfService = new WorkOrderPdfService(app.prisma, storage, service, companySettingsService);

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

      // Phase 8 — de PDF wordt automatisch gegenereerd meteen na ondertekenen
      // (sectie 34, stappen 3-5). `generate()` gooit zelf nooit verder (zie
      // work-order-pdf.service.ts) — bij een mislukking staat de reeds
      // ondertekende, immutable werkbon gewoon met pdfStatus PDF_FAILED in de
      // response, met "PDF opnieuw genereren" als handmatige herstelactie.
      await pdfService.generate(params.id);

      // Phase 9 — meteen daarna de Teamleader-sync inplannen (sectie 34,
      // stappen 6-8: tijdregistraties + PDF naar Teamleader). Dit gebeurt
      // asynchroon via de queue (SyncJobService) — het antwoord op deze
      // request wacht daar niet op, de werkbon toont meteen status
      // SYNC_PENDING en de UI kan nadien pollen/vernieuwen.
      await app.syncJobService.enqueueForWorkOrder(params.id);

      const workOrder = await service.get(params.id);
      reply.code(201);
      return { workOrder: await toSummary(storage, workOrder) };
    },
  );

  /**
   * Phase 9 — handmatige herstelactie (sectie 13: "Administrator moet
   * handmatig: Opnieuw synchroniseren kunnen kiezen"), voor de
   * tijdregistratie- én PDF-upload-sync samen (SyncJobService.retry() slaat
   * reeds geslaagde onderdelen automatisch over). SUPERVISOR+, zelfde reden
   * als PDF-regeneratie hierboven (sectie 4: "synchronisatiefouten behandelen").
   */
  app.post(
    '/work-orders/:id/sync/retry',
    { preHandler: [app.authenticate] },
    async (request): Promise<WorkOrderResponseBody> => {
      const user = request.currentUser;
      if (!user || !roleAtLeast(user.role, 'SUPERVISOR')) {
        throw AuthErrors.insufficientRole();
      }
      const params = workOrderIdParamsSchema.parse(request.params);

      const workOrder = await service.get(params.id);
      if (workOrder.status === 'DRAFT' || workOrder.status === 'READY_FOR_SIGNATURE') {
        throw WorkOrderErrors.notSignedForSync();
      }

      await app.syncJobService.retry(params.id);

      const refreshed = await service.get(params.id);
      return { workOrder: await toSummary(storage, refreshed) };
    },
  );

  /**
   * Phase 9 — overzicht "Synchronisatiefouten" (sectie 4/13). SUPERVISOR+,
   * zelfde rechten als de rest van het sync-beheer.
   */
  app.get(
    '/admin/work-orders/sync-issues',
    { preHandler: [app.authenticate] },
    async (request): Promise<ListWorkOrderSyncIssuesResponseBody> => {
      const user = request.currentUser;
      if (!user || !roleAtLeast(user.role, 'SUPERVISOR')) {
        throw AuthErrors.insufficientRole();
      }
      const workOrders = await service.listSyncIssues();
      return { workOrders: workOrders.map(toSyncIssueSummary) };
    },
  );

  /**
   * Phase 8 — handmatige herstelactie (sectie 13: "Administrator moet
   * handmatig: Opnieuw synchroniseren kunnen kiezen", hier toegepast op
   * PDF-generatie specifiek). SUPERVISOR+ omdat zij per sectie 4
   * "synchronisatiefouten behandelen".
   */
  app.post(
    '/work-orders/:id/pdf/regenerate',
    { preHandler: [app.authenticate] },
    async (request): Promise<WorkOrderResponseBody> => {
      const user = request.currentUser;
      if (!user || !roleAtLeast(user.role, 'SUPERVISOR')) {
        throw AuthErrors.insufficientRole();
      }
      const params = workOrderIdParamsSchema.parse(request.params);

      await pdfService.generate(params.id);

      const workOrder = await service.get(params.id);
      return { workOrder: await toSummary(storage, workOrder) };
    },
  );

  /** Phase 8 — downloadt de gegenereerde PDF zelf (i.p.v. enkel de metadata in WorkOrderSummary). Zelfde toegangsregels als GET /work-orders/:id. */
  app.get('/work-orders/:id/pdf', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = workOrderIdParamsSchema.parse(request.params);
    const workOrder = await service.get(params.id);
    requireWorkOrderAccess(request, workOrder);

    if (workOrder.pdfStatus !== 'PDF_READY' || !workOrder.pdfFileKey) {
      throw WorkOrderErrors.pdfNotReady();
    }

    const file = await storage.read(workOrder.pdfFileKey);
    reply.header('Content-Type', file.mimeType);
    reply.header('Content-Disposition', `inline; filename="${workOrder.pdfFileName ?? 'werkbon.pdf'}"`);
    return reply.send(file.data);
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
    projectSigningMode: workOrder.project.signingMode,
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
    pdfStatus: workOrder.pdfStatus,
    pdfFileName: workOrder.pdfFileName,
    pdfGeneratedAt: workOrder.pdfGeneratedAt ? workOrder.pdfGeneratedAt.toISOString() : null,
    pdfError: workOrder.pdfError,
    timeTrackingSyncStatus: deriveTimeTrackingSyncStatus(workOrder.timeEntries),
    timeTrackingSyncError: deriveTimeTrackingSyncError(workOrder.timeEntries),
    teamleaderUploadStatus: workOrder.teamleaderUploadStatus,
    teamleaderUploadedAt: workOrder.teamleaderUploadedAt ? workOrder.teamleaderUploadedAt.toISOString() : null,
    teamleaderUploadError: workOrder.teamleaderUploadError,
  };
}

function toDataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

/** Phase 9 — lichte rij voor het overzicht "Synchronisatiefouten" (geen foto's/handtekening-bytes nodig). */
function toSyncIssueSummary(workOrder: WorkOrderRecord): WorkOrderSyncIssueSummary {
  return {
    id: workOrder.id,
    workOrderNumber: workOrder.workOrderNumber,
    projectName: workOrder.project.name,
    customerName: workOrder.project.customer.name,
    status: workOrder.status,
    timeTrackingSyncStatus: deriveTimeTrackingSyncStatus(workOrder.timeEntries),
    timeTrackingSyncError: deriveTimeTrackingSyncError(workOrder.timeEntries),
    teamleaderUploadStatus: workOrder.teamleaderUploadStatus,
    teamleaderUploadError: workOrder.teamleaderUploadError,
    updatedAt: workOrder.updatedAt.toISOString(),
  };
}
