import type { PrismaClient, WorkOrderPhotoCategory } from '@prisma/client';
import { WorkOrderErrors } from '../../errors';
import type { StorageService } from '../storage/storage.service';
import type { WorkOrderPhotoRecord } from './work-order.service';

export interface AddWorkOrderPhotoInput {
  category: WorkOrderPhotoCategory | null;
  description: string | null;
  optimized: { data: Buffer; mimeType: string };
  thumbnail: { data: Buffer; mimeType: string };
}

/**
 * Phase 6 — foto's op een werkbon (sectie 9 van de projectbrief). Bewaart de
 * ruwe bytes via `StorageService` (vandaag: bytea in Postgres — zie
 * DatabaseStorageService) en enkel de opaque storage-keys in `WorkOrderPhoto`.
 * De browser comprimeert/verkleint de foto vóór upload (zie
 * apps/web/src/lib/image.ts) — deze service doet zelf geen beeldbewerking.
 */
export class WorkOrderPhotoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
  ) {}

  async add(employeeId: string, workOrderId: string, input: AddWorkOrderPhotoInput): Promise<WorkOrderPhotoRecord> {
    await this.requireEditableParticipant(employeeId, workOrderId);

    const optimizedFileKey = await this.storage.save(input.optimized.data, input.optimized.mimeType);
    const thumbnailFileKey = await this.storage.save(input.thumbnail.data, input.thumbnail.mimeType);

    const created = await this.prisma.workOrderPhoto.create({
      data: {
        workOrderId,
        category: input.category,
        description: input.description,
        optimizedFileKey,
        thumbnailFileKey,
        uploadedByEmployeeId: employeeId,
      },
      include: { uploadedByEmployee: true },
    });

    return created;
  }

  async remove(employeeId: string, workOrderId: string, photoId: string): Promise<void> {
    await this.requireEditableParticipant(employeeId, workOrderId);

    const photo = await this.prisma.workOrderPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.workOrderId !== workOrderId) {
      throw WorkOrderErrors.photoNotFound();
    }

    await this.prisma.workOrderPhoto.delete({ where: { id: photoId } });

    // Best-effort: de foto-rij is de bron van waarheid. Mislukt het opruimen
    // van de onderliggende bytes (bv. tijdelijke storage-storing), dan mag
    // dat de verwijdering van de foto zelf niet blokkeren (business rule 9).
    await this.storage.delete(photo.optimizedFileKey);
    await this.storage.delete(photo.thumbnailFileKey);
  }

  /**
   * Gooit WorkOrderErrors.notFound() wanneer de werkbon niet bestaat, of
   * wanneer deze werknemer er geen deelnemer van is (zelfde anti-
   * enumeratiepatroon als requireWorkOrderAccess in work-order.routes.ts — nooit
   * onderscheiden van "bestaat niet"). Gooit WorkOrderErrors.alreadySigned()
   * zodra de werkbon niet meer DRAFT is (business rule 3: een ondertekende
   * werkbon is immutable).
   */
  private async requireEditableParticipant(employeeId: string, workOrderId: string): Promise<void> {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: {
        status: true,
        createdByEmployeeId: true,
        timeEntries: { select: { timeEntry: { select: { employeeId: true } } } },
      },
    });
    if (!workOrder) {
      throw WorkOrderErrors.notFound();
    }
    const isParticipant =
      workOrder.createdByEmployeeId === employeeId ||
      workOrder.timeEntries.some((link: { timeEntry: { employeeId: string } }) => link.timeEntry.employeeId === employeeId);
    if (!isParticipant) {
      throw WorkOrderErrors.notFound();
    }
    if (workOrder.status !== 'DRAFT') {
      throw WorkOrderErrors.alreadySigned();
    }
  }
}
