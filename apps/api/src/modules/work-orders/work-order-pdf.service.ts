import type { PrismaClient } from '@prisma/client';
import { WorkOrderErrors } from '../../errors';
import type { CompanySettingsService } from '../company-settings/company-settings.service';
import type { StorageService } from '../storage/storage.service';
import { renderWorkOrderPdf, type WorkOrderPdfData } from './work-order-pdf-document';
import type { WorkOrderRecord } from './work-order.service';
import type { WorkOrderService } from './work-order.service';

/** Mensentaal-fout (sectie 27) — het echte foutdetail gaat naar de server-log (console.error hieronder), nooit rechtstreeks naar de client. */
const GENERIC_PDF_FAILURE_MESSAGE = 'Het genereren van de PDF is mislukt. Probeer het opnieuw via "PDF opnieuw genereren".';

/**
 * Phase 8 — PDF-generatie (secties 12/13/31 van de projectbrief), bewust
 * losgekoppeld van een eventuele latere Teamleader-upload (Phase 9, sectie
 * 31: "PDF EN TEAMLEADER MOETEN LOSGEKOPPELD ZIJN"). Deze ronde: geen
 * queue/worker — @react-pdf/renderer is snel genoeg (geen externe
 * netwerkcalls) om synchroon binnen hetzelfde request te draaien (zie
 * work-order.routes.ts, `/sign`), net zoals de rest van deze MVP-fase geen
 * onnodige infrastructuur toevoegt vóór ze écht nodig is (een queue komt
 * wél bij Phase 9, waar de brief die expliciet vraagt voor Teamleader-sync).
 */
export class WorkOrderPdfService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly workOrderService: WorkOrderService,
    private readonly companySettings: CompanySettingsService,
  ) {}

  /**
   * Genereert (of hergenereert) de PDF voor een ondertekende werkbon.
   *
   * Preconditie-fouten (niet ondertekend, of al bezig) gooien wél — dat is
   * verkeerd gebruik van deze functie, geen runtime-generatiefout, en
   * gebeurt vóór er iets aan de werkbon gewijzigd wordt.
   *
   * Eenmaal voorbij die check gooit deze functie NOOIT meer verder: sectie
   * 27/31 — een mislukte PDF-generatie mag de al ondertekende, immutable
   * werkbon nooit "kapotmaken" of laten verdwijnen. Bij een fout wordt enkel
   * de status/foutmelding op de werkbon bijgewerkt (PDF_FAILED), zichtbaar in
   * de UI met een "opnieuw genereren"-actie (zie work-order.routes.ts,
   * `/pdf/regenerate`).
   */
  async generate(workOrderId: string): Promise<void> {
    const workOrder = await this.workOrderService.get(workOrderId);
    if (workOrder.status === 'DRAFT' || !workOrder.signature) {
      throw WorkOrderErrors.notSignedForPdf();
    }
    if (workOrder.pdfStatus === 'PDF_GENERATING') {
      throw WorkOrderErrors.pdfGenerationInProgress();
    }

    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { pdfStatus: 'PDF_GENERATING', pdfError: null },
    });

    try {
      const data = await this.buildPdfData(workOrder);
      const buffer = await renderWorkOrderPdf(data);
      const pdfFileKey = await this.storage.save(buffer, 'application/pdf');
      const pdfFileName = buildPdfFileName(workOrder.workOrderNumber, workOrder.project.customer.name, workOrder.project.name);

      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          pdfStatus: 'PDF_READY',
          pdfFileKey,
          pdfFileName,
          pdfGeneratedAt: new Date(),
          pdfError: null,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- bewust: enige plek waar de ruwe fout zichtbaar blijft (server-log/Render-logs), zie toelichting hierboven.
      console.error(`[WorkOrderPdfService] PDF-generatie mislukt voor werkbon ${workOrderId}`, err);
      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: { pdfStatus: 'PDF_FAILED', pdfError: GENERIC_PDF_FAILURE_MESSAGE },
      });
    }
  }

  private async buildPdfData(workOrder: WorkOrderRecord): Promise<WorkOrderPdfData> {
    if (!workOrder.signature) {
      // Kan hier niet meer voorkomen (guard in generate()) — enkel voor TypeScript-narrowing.
      throw WorkOrderErrors.notSignedForPdf();
    }
    const signature = workOrder.signature;

    const company = await this.companySettings.get();

    const [signatureImage, logoImage, photos] = await Promise.all([
      this.storage.read(signature.signatureFileKey),
      company.logoFileKey ? this.storage.read(company.logoFileKey) : Promise.resolve(null),
      Promise.all(
        workOrder.photos.map(async (photo) => {
          const image = await this.storage.read(photo.optimizedFileKey);
          return {
            data: image.data,
            mimeType: image.mimeType,
            category: photo.category,
            description: photo.description,
          };
        }),
      ),
    ]);

    return {
      workOrderNumber: workOrder.workOrderNumber,
      customerName: workOrder.project.customer.name,
      projectName: workOrder.project.name,
      projectNumber: workOrder.project.projectNumber,
      projectAddress: workOrder.project.address ?? workOrder.project.customer.address,
      description: workOrder.description,
      timeEntries: workOrder.timeEntries.map((link) => ({
        employeeDisplayName: link.timeEntry.employee.displayName,
        startedAt: link.timeEntry.startedAt,
        endedAt: link.timeEntry.endedAt,
        pausedSeconds: link.timeEntry.pausedSeconds,
      })),
      photos,
      signature: {
        signerName: signature.signerName,
        signerFunction: signature.signerFunction,
        signedAt: signature.signedAt,
        image: signatureImage,
      },
      company: {
        companyName: company.companyName,
        addressLine: company.addressLine,
        vatNumber: company.vatNumber,
        contactEmail: company.contactEmail,
        contactPhone: company.contactPhone,
        logo: logoImage,
        legalText: company.workOrderLegalText,
      },
    };
  }
}

/**
 * Sectie 12: "WB-2026-000123_Janssens_Project-Airco.pdf" — ASCII-veilig
 * (accenten/leestekens weg, spaties → streepjes) zodat elke downstream-
 * consument (browser-download, later een eventuele Teamleader-upload in
 * Phase 9) een probleemloze bestandsnaam krijgt.
 */
export function buildPdfFileName(workOrderNumber: string, customerName: string, projectName: string): string {
  return `${workOrderNumber}_${slugify(customerName)}_${slugify(projectName)}.pdf`;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accenten weg (bv. é → e)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
