import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { WeeklyApprovalErrors } from '../../errors';
import type { CompanySettingsService } from '../company-settings/company-settings.service';
import { computeKmAmountCents } from '../distance/distance.service';
import type { StorageService } from '../storage/storage.service';

/**
 * Phase 12, deel B (sectie 2) — "werkbonnen per week laten tekenen door de
 * klant". Zie de uitgebreide toelichting bij het `WeeklyApproval`-model in
 * schema.prisma voor waarom dit bewust GEEN eigen PDF/Teamleader-
 * uploadpijplijn heeft: elke onderliggende werkbon doorloopt zijn eigen
 * bestaande PDF-generatie + sync (Phase 8/9) ongewijzigd, enkel de
 * handtekening zelf wordt één keer voor de hele week ingezameld.
 *
 * Kalenderweek = maandag t.e.m. zondag, bepaald op `WorkOrder.createdAt`
 * (geen apart "werkdatum"-veld op WorkOrder — een werkbon ontstaat op de dag
 * zelf, zie WorkOrderService.create()).
 */

export interface SignWeekInput {
  signerName: string;
  signerFunction: string | null;
  requestedByUserId: string;
  ipAddress: string | null;
  image: { data: Buffer; mimeType: string };
}

/** Eén tijdregistratie-rij ter review vóór de klant tekent — zie listPendingForEmployee(). */
export interface PendingWeekEntry {
  workOrderId: string;
  workOrderNumber: string;
  employeeDisplayName: string;
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
}

export interface WeeklyApprovalRecord {
  id: string;
  projectId: string;
  weekStartDate: Date;
  weekEndDate: Date;
  status: 'OPEN' | 'SIGNED' | 'REOPENED';
  signerName: string | null;
  signerFunction: string | null;
  confirmedAt: Date | null;
  workOrderIds: string[];
}

interface PendingWorkOrderRow {
  id: string;
  workOrderNumber: string;
  status: string;
  createdByEmployeeId: string;
  description: string | null;
  createdAt: Date;
  timeEntries: Array<{
    timeEntryId: string;
    timeEntry: {
      employeeId: string;
      startedAt: Date;
      endedAt: Date | null;
      pausedSeconds: number;
      employee: { displayName: string };
    };
  }>;
  photos: Array<{ id: string }>;
}

export class WeeklyApprovalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly companySettingsService: CompanySettingsService,
  ) {}

  /** Maandag 00:00 t.e.m. zondag 23:59:59 van de week waarin `reference` valt (default: vandaag). */
  static weekBoundsOf(reference: Date = new Date()): { weekStartDate: Date; weekEndDate: Date } {
    const day = reference.getUTCDay(); // 0 = zondag
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const weekStartDate = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + diffToMonday));
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    weekEndDate.setUTCHours(23, 59, 59, 999);
    return { weekStartDate, weekEndDate };
  }

  /**
   * Werkbonnen die klaarstaan voor weekondertekening op dit project, voor de
   * lopende week, waarbij deze medewerker betrokken is (zelfde
   * participant-check als WorkOrderSignatureService — aanmaker of één van de
   * gekoppelde tijdregistraties).
   */
  async listPendingForEmployee(
    employeeId: string,
    projectId: string,
  ): Promise<{ weekStartDate: Date; weekEndDate: Date; workOrderIds: string[]; entries: PendingWeekEntry[] }> {
    const { weekStartDate, weekEndDate } = WeeklyApprovalService.weekBoundsOf();
    const rows = await this.fetchPendingWorkOrders(projectId, weekStartDate, weekEndDate);
    const mine = rows.filter(
      (row) => row.createdByEmployeeId === employeeId || row.timeEntries.some((link) => link.timeEntry.employeeId === employeeId),
    );

    // Op vraag (2/9/2026): "alle tijden tonen zodat de ondertekenaar ziet wat
    // hij goedkeurt" — bewust over ALLE openstaande werkbonnen van deze week
    // heen (niet gefilterd op `mine`), want de handtekening zelf bevestigt
    // ook alle collega's se werkbonnen (sectie 2), niet enkel die van de
    // medewerker die de onderteken-actie start.
    const entries: PendingWeekEntry[] = rows.flatMap((row) =>
      row.timeEntries.map((link) => ({
        workOrderId: row.id,
        workOrderNumber: row.workOrderNumber,
        employeeDisplayName: link.timeEntry.employee.displayName,
        startedAt: link.timeEntry.startedAt,
        // endedAt is gegarandeerd niet-null: enkel gestopte tijdregistraties
        // hangen aan een DRAFT-werkbon die hier al opgehaald wordt.
        endedAt: link.timeEntry.endedAt!,
        pausedSeconds: link.timeEntry.pausedSeconds,
      })),
    );
    entries.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    return { weekStartDate, weekEndDate, workOrderIds: mine.map((row) => row.id), entries };
  }

  /**
   * Ondertekent de volledige lopende week voor dit project in één keer —
   * bundelt ALLE nog niet ondertekende werkbonnen van deze week (over
   * meerdere medewerkers heen, sectie 2), niet enkel die van de uitvoerder
   * die de actie start.
   */
  async signCurrentWeek(projectId: string, input: SignWeekInput): Promise<WeeklyApprovalRecord> {
    const { weekStartDate, weekEndDate } = WeeklyApprovalService.weekBoundsOf();
    const pending = await this.fetchPendingWorkOrders(projectId, weekStartDate, weekEndDate);
    if (pending.length === 0) {
      throw WeeklyApprovalErrors.noPendingWorkOrders();
    }

    // Phase 12, deel D (sectie 5) — alle werkbonnen in deze batch horen bij
    // hetzelfde project, dus delen ze dezelfde km-afstand; één berekening
    // volstaat i.p.v. per werkbon. Bevroren op het moment van ondertekenen,
    // net als bij de individuele `/work-orders/:id/sign` (zie
    // work-order-signature.service.ts).
    const [project, companySettings] = await Promise.all([
      this.prisma.project.findUnique({ where: { id: projectId }, select: { kmDistanceOneWayMeters: true } }),
      this.companySettingsService.get(),
    ]);
    const kmAmountCents = computeKmAmountCents(project?.kmDistanceOneWayMeters ?? null, companySettings.kmRateCents);

    const signatureFileKey = await this.storage.save(input.image.data, input.image.mimeType);
    const confirmedAt = new Date();

    try {
      const [weeklyApproval] = await this.prisma.$transaction([
        this.prisma.weeklyApproval.upsert({
          where: { projectId_weekStartDate: { projectId, weekStartDate } },
          create: {
            projectId,
            weekStartDate,
            weekEndDate,
            status: 'SIGNED',
            signerName: input.signerName,
            signerFunction: input.signerFunction,
            confirmedAt,
            ipAddress: input.ipAddress,
            requestedByUserId: input.requestedByUserId,
          },
          update: {
            status: 'SIGNED',
            signerName: input.signerName,
            signerFunction: input.signerFunction,
            confirmedAt,
            ipAddress: input.ipAddress,
            requestedByUserId: input.requestedByUserId,
          },
        }),
        ...pending.map((row) =>
          this.prisma.workOrderSignature.create({
            data: {
              workOrderId: row.id,
              signerName: input.signerName,
              signerFunction: input.signerFunction,
              signatureFileKey,
              signedAt: confirmedAt,
              ipAddress: input.ipAddress,
              contentHash: computeContentHash(row),
              requestedByUserId: input.requestedByUserId,
            },
          }),
        ),
        this.prisma.workOrder.updateMany({
          where: { id: { in: pending.map((row) => row.id) } },
          data: { status: 'SIGNED', kmAmountCents },
        }),
      ]);

      // De WeeklyApproval-id is pas gekend ná de upsert hierboven, en
      // `updateMany` kan geen sub-query gebruiken — vandaar deze ene extra
      // aanroep, WEL nog binnen dezelfde logische operatie: als deze faalt na
      // een geslaagde transactie hierboven, blijven de betrokken werkbonnen
      // SIGNED zonder weeklyApprovalId. Dat is onschadelijk (geen dubbele
      // betaling/facturatie-impact, enkel de "welke week hoort hierbij"-link
      // ontbreekt dan tijdelijk) en zelfhelend: een retry van deze exacte
      // aanroep (bv. via een handmatige herstelactie) zet hem alsnog correct.
      await this.prisma.workOrder.updateMany({
        where: { id: { in: pending.map((row) => row.id) } },
        data: { weeklyApprovalId: weeklyApproval.id },
      });

      return toRecord(weeklyApproval, pending.map((row) => row.id));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Race: iemand anders ondertekende exact deze week al tussen de
        // fetchPendingWorkOrders()-lezing en dit schrijfmoment.
        throw WeeklyApprovalErrors.alreadySigned();
      }
      throw err;
    }
  }

  /**
   * Heropent een ondertekende week (sectie 11: "bestaande handtekening
   * ongeldig verklaren") — SUPERVISOR+. Elke onderliggende werkbon valt
   * terug naar DRAFT en verliest zijn handtekening + PDF/Teamleader-status
   * (die waren immers gebaseerd op de nu ongeldige handtekening); een
   * volgende `signCurrentWeek()`-aanroep voor dezelfde week vindt deze
   * werkbonnen dan gewoon opnieuw als "nog te ondertekenen".
   */
  async reopen(weeklyApprovalId: string): Promise<void> {
    const weeklyApproval = await this.prisma.weeklyApproval.findUnique({
      where: { id: weeklyApprovalId },
      include: { workOrders: { select: { id: true } } },
    });
    if (!weeklyApproval) {
      throw WeeklyApprovalErrors.notFound();
    }
    if (weeklyApproval.status !== 'SIGNED') {
      throw WeeklyApprovalErrors.notSigned();
    }

    const workOrderIds = weeklyApproval.workOrders.map((wo: { id: string }) => wo.id);

    await this.prisma.$transaction([
      this.prisma.weeklyApproval.update({ where: { id: weeklyApprovalId }, data: { status: 'REOPENED' } }),
      this.prisma.workOrderSignature.deleteMany({ where: { workOrderId: { in: workOrderIds } } }),
      this.prisma.workOrder.updateMany({
        where: { id: { in: workOrderIds } },
        data: {
          status: 'DRAFT',
          pdfStatus: 'PDF_PENDING',
          pdfFileKey: null,
          pdfFileName: null,
          pdfGeneratedAt: null,
          pdfError: null,
          teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_PENDING',
          teamleaderFileId: null,
          teamleaderUploadedAt: null,
          teamleaderUploadError: null,
          // Phase 12, deel D — een heropende werkbon bevriest een nieuw
          // kmAmountCents pas bij de volgende ondertekening (zelfde reden als
          // de PDF/sync-velden hierboven: het oude bevroren bedrag hoort niet
          // meer bij een geldige handtekening).
          kmAmountCents: null,
        },
      }),
    ]);
  }

  private async fetchPendingWorkOrders(projectId: string, weekStartDate: Date, weekEndDate: Date): Promise<PendingWorkOrderRow[]> {
    return (await this.prisma.workOrder.findMany({
      where: {
        projectId,
        status: 'DRAFT',
        createdAt: { gte: weekStartDate, lte: weekEndDate },
      },
      select: {
        id: true,
        workOrderNumber: true,
        status: true,
        createdByEmployeeId: true,
        description: true,
        createdAt: true,
        timeEntries: {
          select: {
            timeEntryId: true,
            timeEntry: {
              select: {
                employeeId: true,
                startedAt: true,
                endedAt: true,
                pausedSeconds: true,
                employee: { select: { displayName: true } },
              },
            },
          },
        },
        photos: { select: { id: true } },
      },
    })) as unknown as PendingWorkOrderRow[];
  }
}

/** Zelfde formule als WorkOrderSignatureService.computeContentHash — bewust identiek gehouden (één werkbon = één contentHash-definitie, ongeacht via welke flow ze ondertekend wordt). */
function computeContentHash(row: PendingWorkOrderRow): string {
  const canonical = JSON.stringify({
    description: row.description,
    timeEntryIds: [...row.timeEntries.map((link) => link.timeEntryId)].sort(),
    photoIds: [...row.photos.map((photo) => photo.id)].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function toRecord(
  weeklyApproval: {
    id: string;
    projectId: string;
    weekStartDate: Date;
    weekEndDate: Date;
    status: string;
    signerName: string | null;
    signerFunction: string | null;
    confirmedAt: Date | null;
  },
  workOrderIds: string[],
): WeeklyApprovalRecord {
  return {
    id: weeklyApproval.id,
    projectId: weeklyApproval.projectId,
    weekStartDate: weeklyApproval.weekStartDate,
    weekEndDate: weeklyApproval.weekEndDate,
    status: weeklyApproval.status as 'OPEN' | 'SIGNED' | 'REOPENED',
    signerName: weeklyApproval.signerName,
    signerFunction: weeklyApproval.signerFunction,
    confirmedAt: weeklyApproval.confirmedAt,
    workOrderIds,
  };
}
