import { Prisma, type PrismaClient } from '@prisma/client';
import { ProjectErrors, WorkOrderErrors } from '../../errors';

const WITH_DETAILS = {
  include: {
    project: { include: { customer: true } },
    createdByEmployee: true,
    timeEntries: {
      include: {
        timeEntry: { include: { employee: true } },
      },
    },
    // Phase 6/7 — foto's en handtekening. Bevatten enkel opaque storage-keys
    // (zie StorageService), geen ruwe bytes — die haalt de route-laag pas op
    // wanneer een werkbon écht opgevraagd wordt (toSummary() in
    // work-order.routes.ts is daarom async).
    photos: { include: { uploadedByEmployee: true }, orderBy: { createdAt: 'asc' } },
    signature: { include: { requestedByUser: true } },
  },
} as const;

export interface WorkOrderPhotoRecord {
  id: string;
  category: string | null;
  description: string | null;
  optimizedFileKey: string;
  thumbnailFileKey: string;
  uploadedByEmployeeId: string;
  uploadedByEmployee: { displayName: string };
  createdAt: Date;
}

export interface WorkOrderSignatureRecord {
  id: string;
  signerName: string;
  signerFunction: string | null;
  signatureFileKey: string;
  signedAt: Date;
  contentHash: string;
  requestedByUserId: string;
}

export interface WorkOrderRecord {
  id: string;
  workOrderNumber: string;
  projectId: string;
  status: 'DRAFT' | 'READY_FOR_SIGNATURE' | 'SIGNED' | 'SYNC_PENDING' | 'SYNC_FAILED' | 'READY_FOR_INVOICING' | 'INVOICED';
  description: string | null;
  createdByEmployeeId: string;
  createdAt: Date;
  updatedAt: Date;
  project: {
    name: string;
    customer: { name: string };
  };
  createdByEmployee: { displayName: string };
  timeEntries: Array<{
    id: string;
    timeEntry: {
      id: string;
      employeeId: string;
      startedAt: Date;
      endedAt: Date | null;
      pausedSeconds: number;
      employee: { displayName: string };
    };
  }>;
  photos: WorkOrderPhotoRecord[];
  signature: WorkOrderSignatureRecord | null;
}

/**
 * Phase 5 — werkbonnen (basis). Een werkbon wordt aangemaakt vanuit één of
 * meer gestopte, nog niet-gekoppelde tijdsregistraties van de aanvragende
 * werknemer op hetzelfde project (zie ProjectTimerPage.tsx: automatisch na
 * "Bevestig stoppen", zonder aparte klik). Het samenvoegen van meerdere
 * werknemers' registraties tot één gedeelde werkbon (sectie 8 van de brief)
 * is datamodel-technisch al mogelijk (zie WorkOrderTimeEntry) maar heeft in
 * deze ronde nog geen UI-flow — dat is bewust uitgesteld tot een latere fase.
 */
export class WorkOrderService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(id: string): Promise<WorkOrderRecord> {
    const workOrder = await this.prisma.workOrder.findUnique({ where: { id }, ...WITH_DETAILS });
    if (!workOrder) {
      throw WorkOrderErrors.notFound();
    }
    return workOrder;
  }

  async create(
    employeeId: string,
    projectId: string,
    timeEntryIds: string[],
    description: string | null,
  ): Promise<WorkOrderRecord> {
    if (timeEntryIds.length === 0) {
      throw WorkOrderErrors.noTimeEntries();
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }

    // Elke meegegeven tijdsregistratie moet: bestaan, van deze werknemer zijn,
    // gestopt zijn, bij dit project horen, en nog niet aan een werkbon
    // gekoppeld zijn. Eén duidelijke query i.p.v. per ID een aparte
    // findUnique — geeft meteen een volledig beeld i.p.v. te stoppen bij de
    // eerste afwijkende ID.
    const timeEntries = await this.prisma.timeEntry.findMany({
      where: { id: { in: timeEntryIds } },
      include: { workOrderLink: true },
    });

    if (timeEntries.length !== timeEntryIds.length) {
      throw WorkOrderErrors.invalidTimeEntry();
    }
    for (const entry of timeEntries) {
      if (entry.employeeId !== employeeId || entry.status !== 'STOPPED') {
        throw WorkOrderErrors.invalidTimeEntry();
      }
      if (entry.projectId !== projectId) {
        throw WorkOrderErrors.timeEntryProjectMismatch();
      }
      if (entry.workOrderLink) {
        throw WorkOrderErrors.timeEntryAlreadyLinked();
      }
    }

    const workOrderNumber = await this.allocateWorkOrderNumber();

    try {
      const created = await this.prisma.workOrder.create({
        data: {
          workOrderNumber,
          projectId,
          description,
          createdByEmployeeId: employeeId,
          timeEntries: { create: timeEntryIds.map((timeEntryId) => ({ timeEntryId })) },
        },
        ...WITH_DETAILS,
      });
      return created;
    } catch (err) {
      // Backstop tegen een race condition: twee gelijktijdige aanvragen die
      // dezelfde tijdsregistratie proberen te koppelen (zelfde patroon als
      // TimeEntryService.start() bij TIME_ENTRY_ALREADY_ACTIVE).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw WorkOrderErrors.timeEntryAlreadyLinked();
      }
      throw err;
    }
  }

  /**
   * Atomair volgnummer per jaar (bv. 123 → "WB-2026-000123"). `create()` faalt
   * enkel wanneer er voor dit jaar nog geen tellerrij bestaat; de daaropvolgende
   * `update()` met `{ increment: 1 }` is een atomaire databank-UPDATE, dus
   * gelijktijdige aanvragen binnen hetzelfde jaar serialiseren correct zonder
   * dubbele nummers.
   */
  private async allocateWorkOrderNumber(): Promise<string> {
    const year = new Date().getFullYear();
    let lastNumber: number;
    try {
      const counter = await this.prisma.workOrderCounter.create({ data: { year, lastNumber: 1 } });
      lastNumber = counter.lastNumber;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const counter = await this.prisma.workOrderCounter.update({
          where: { year },
          data: { lastNumber: { increment: 1 } },
        });
        lastNumber = counter.lastNumber;
      } else {
        throw err;
      }
    }
    return `WB-${year}-${String(lastNumber).padStart(6, '0')}`;
  }
}
