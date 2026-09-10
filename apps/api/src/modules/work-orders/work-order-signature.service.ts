import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { WorkOrderErrors } from '../../errors';
import { computeKmAmountCents } from '../distance/distance.service';
import type { StorageService } from '../storage/storage.service';
import type { WorkOrderSignatureRecord } from './work-order.service';

export interface SignWorkOrderInput {
  signerName: string;
  signerFunction: string | null;
  /** De ingelogde gebruiker die de ondertekening aanvroeg (sectie 10 — "user die ondertekening heeft gevraagd"). */
  requestedByUserId: string;
  /** Sectie 10: "eventueel IP-adres indien juridisch/GDPR-technisch wenselijk". */
  ipAddress: string | null;
  image: { data: Buffer; mimeType: string };
  /**
   * Klantvraag 10/9/2026: "verplaatsing manueel kunnen ingeven, want sommige
   * medewerkers vertrekken van thuis i.p.v. het bedrijfsadres." Rijafstand
   * ÉÉN richting, in meter — de medewerker ziet standaard de automatisch
   * berekende projectafstand vooringevuld, maar mag dat vóór ondertekenen
   * overschrijven. `undefined`/`null` = geen correctie, gebruik de
   * projectberekening (zelfde gedrag als vóór deze wijziging).
   */
  kmDistanceOneWayMetersOverride?: number | null;
}

interface WorkOrderSnapshot {
  status: string;
  createdByEmployeeId: string;
  description: string | null;
  timeEntryIds: string[];
  photoIds: string[];
  /** Phase 12, deel D — nodig om kmAmountCents te bevriezen op het moment van ondertekenen. */
  projectKmDistanceOneWayMeters: number | null;
  /** Klantvraag 10/9/2026 — per-project prijsinstellingen, zie Project.kmFlatFeeThresholdKm/kmFlatFeeCents/kmRateAboveCentsPerKm in schema.prisma. */
  projectKmFlatFeeThresholdKm: number;
  projectKmFlatFeeCents: number | null;
  projectKmRateAboveCentsPerKm: number;
}

/**
 * Phase 7 — verplichte digitale handtekening van de klant (sectie 10 van de
 * projectbrief). Ondertekenen is de overgang DRAFT → SIGNED (business rule 3:
 * een ondertekende werkbon is immutable) — vandaar de transactionele
 * gecombineerde create()+update() hieronder, zodat er nooit een
 * WorkOrderSignature-rij kan bestaan zonder dat de werkbon ook effectief
 * SIGNED is (of omgekeerd).
 *
 * `contentHash` is een lichtgewicht tamper-evidence-signaal (SHA-256 van een
 * canonieke snapshot), GEEN volledige WorkOrderVersion-audittrail (sectie 11
 * van de brief) — het volledige heropenen/hertekenen van een ondertekende
 * werkbon is bewust een latere fase.
 *
 * Zie weekly-approval.service.ts (Phase 12, deel B) voor de weekondertekening
 * — die herbruikt bewust dezelfde `WorkOrderSignature`-vorm en `contentHash`-
 * formule, maar als eigen, onafhankelijke transactie (bundelt meerdere
 * werkbonnen tegelijk), niet via deze klasse.
 */
export class WorkOrderSignatureService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
  ) {}

  async sign(employeeId: string, workOrderId: string, input: SignWorkOrderInput): Promise<WorkOrderSignatureRecord> {
    const snapshot = await this.requireEditableParticipant(employeeId, workOrderId);

    const signatureFileKey = await this.storage.save(input.image.data, input.image.mimeType);
    const signedAt = new Date();
    const contentHash = computeContentHash(snapshot);

    // Phase 12, deel D (sectie 5), uitgebreid op klantvraag 10/9/2026 —
    // bevriezen op het moment van ondertekenen: wijzigt het projectadres of
    // de prijsinstellingen later, dan blijft dit bedrag op deze al
    // ondertekende werkbon ongewijzigd. De effectieve afstand is de manuele
    // correctie indien opgegeven, anders de automatisch berekende
    // projectafstand (ongewijzigd gedrag t.o.v. vóór deze wijziging).
    const effectiveKmDistanceOneWayMeters = input.kmDistanceOneWayMetersOverride ?? snapshot.projectKmDistanceOneWayMeters;
    const kmAmountCents = computeKmAmountCents(effectiveKmDistanceOneWayMeters, {
      flatFeeThresholdKm: snapshot.projectKmFlatFeeThresholdKm,
      flatFeeCents: snapshot.projectKmFlatFeeCents,
      rateAboveCentsPerKm: snapshot.projectKmRateAboveCentsPerKm,
    });

    try {
      const [signature] = await this.prisma.$transaction([
        this.prisma.workOrderSignature.create({
          data: {
            workOrderId,
            signerName: input.signerName,
            signerFunction: input.signerFunction,
            signatureFileKey,
            signedAt,
            ipAddress: input.ipAddress,
            contentHash,
            requestedByUserId: input.requestedByUserId,
          },
        }),
        this.prisma.workOrder.update({
          where: { id: workOrderId },
          data: { status: 'SIGNED', kmAmountCents, kmDistanceOneWayMeters: effectiveKmDistanceOneWayMeters },
        }),
      ]);
      return signature;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Race: twee gelijktijdige ondertekenpogingen op dezelfde werkbon —
        // de unieke `work_order_id`-index op work_order_signature ving dit op
        // nadat de statuscheck hieronder al voorbij was.
        throw WorkOrderErrors.alreadySigned();
      }
      throw err;
    }
  }

  /**
   * Zelfde anti-enumeratie- en immutability-patroon als
   * WorkOrderPhotoService.requireEditableParticipant — zie de toelichting
   * daar. Geeft meteen de gegevens terug die nodig zijn voor `contentHash`.
   */
  private async requireEditableParticipant(employeeId: string, workOrderId: string): Promise<WorkOrderSnapshot> {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: {
        status: true,
        createdByEmployeeId: true,
        description: true,
        timeEntries: { select: { timeEntryId: true, timeEntry: { select: { employeeId: true } } } },
        photos: { select: { id: true } },
        project: {
          select: {
            kmDistanceOneWayMeters: true,
            kmFlatFeeThresholdKm: true,
            kmFlatFeeCents: true,
            kmRateAboveCentsPerKm: true,
          },
        },
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
    return {
      status: workOrder.status,
      createdByEmployeeId: workOrder.createdByEmployeeId,
      description: workOrder.description,
      timeEntryIds: workOrder.timeEntries.map((link: { timeEntryId: string }) => link.timeEntryId),
      photoIds: workOrder.photos.map((photo: { id: string }) => photo.id),
      projectKmDistanceOneWayMeters: workOrder.project.kmDistanceOneWayMeters,
      projectKmFlatFeeThresholdKm: workOrder.project.kmFlatFeeThresholdKm,
      projectKmFlatFeeCents: workOrder.project.kmFlatFeeCents,
      projectKmRateAboveCentsPerKm: workOrder.project.kmRateAboveCentsPerKm,
    };
  }
}

/**
 * SHA-256 van een canonieke JSON-snapshot — gesorteerde ID-arrays zodat de
 * hash niet afhangt van query-volgorde, enkel van de effectieve inhoud.
 */
function computeContentHash(snapshot: WorkOrderSnapshot): string {
  const canonical = JSON.stringify({
    description: snapshot.description,
    timeEntryIds: [...snapshot.timeEntryIds].sort(),
    photoIds: [...snapshot.photoIds].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
