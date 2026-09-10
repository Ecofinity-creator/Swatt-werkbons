import type { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { InvoiceBatchErrors } from '../../errors';
import type { StorageService } from '../storage/storage.service';
import { slugify } from '../work-orders/work-order-pdf.service';

/** Handgeschreven vorm van de query hieronder — zelfde reden als elders in deze codebase (stale gegenereerde Prisma-client in de sandbox). */
interface BundleWorkOrderRow {
  id: string;
  workOrderNumber: string;
  pdfStatus: string;
  pdfFileKey: string | null;
  signature: { signedAt: Date } | null;
}

interface BundleBatchRow {
  id: string;
  periodLabel: string;
  customer: { name: string };
  lines: Array<{ workOrder: BundleWorkOrderRow }>;
}

export interface WorkOrderPdfBundleResult {
  fileName: string;
  data: Buffer;
}

/**
 * Klantvraag 10/9/2026 — "het moet mogelijk zijn de werkbonnen te
 * exporteren per klant/per maand of per klant/per week in 1 pdf. dus alle
 * afzonderlijke werkbonnen afzonderlijk laten zoals ze gemaakt worden maar
 * in 1 bestand per week zetten, wat meegestuurd wordt met de factuur."
 *
 * Bewust een aparte, kleine service (i.p.v. dit in WorkOrderPdfService of
 * InvoiceBatchService onder te brengen): dit bouwt GEEN nieuwe werkbon-PDF
 * (dat blijft WorkOrderPdfService, sectie 31 — "PDF EN TEAMLEADER MOETEN
 * LOSGEKOPPELD ZIJN"), het voegt enkel reeds gegenereerde, onaangeroerde
 * PDF's samen tot één bestand via `pdf-lib` (i.t.t. `@react-pdf/renderer`,
 * dat enkel nieuwe PDF's kan RENDEREN, geen bestaande kan MERGEN). Elke
 * individuele werkbon-PDF blijft exact zoals ze was — deze service leest ze
 * enkel uit `StorageService` en plakt de pagina's achter elkaar.
 *
 * Een InvoiceBatch is altijd al per klant+maand (zie InvoiceBatchService.create
 * — `periodLabel`), dus "per maand" = de volledige batch, geen `week`-filter
 * nodig. "Per week" groepeert op de ISO-8601-week van de ONDERTEKENINGSDATUM
 * van elke werkbon (`WorkOrderSignature.signedAt`) — bewust een andere
 * sleutel dan de ISO-week-groepering in teamleader-invoice.service.ts (die
 * groepeert op de datum van de WERKELIJK GEWERKTE uren, wat voor een
 * facturatiesectie de juiste keuze is). Voor "stuur deze week se werkbonnen
 * mee met de factuur" is de ondertekeningsdatum de praktische, ondubbelzinnige
 * keuze: elke werkbon heeft precies één ondertekeningsmoment (i.t.t. mogelijk
 * meerdere tijdregistraties op meerdere dagen).
 */
export class InvoiceBatchPdfBundleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
  ) {}

  /** `weekKey`: ISO-8601-weeksleutel ("2026-W32", zie isoWeekKeyOf hieronder) — `undefined` bundelt de volledige batch (= de hele maand). */
  async buildBundle(batchId: string, weekKey?: string): Promise<WorkOrderPdfBundleResult> {
    const batch = (await this.prisma.invoiceBatch.findUnique({
      where: { id: batchId },
      include: {
        customer: true,
        lines: { include: { workOrder: { include: { signature: true } } } },
      },
    })) as BundleBatchRow | null;
    if (!batch) {
      throw InvoiceBatchErrors.notFound();
    }

    const workOrders = batch.lines
      .map((line) => line.workOrder)
      .filter((workOrder) => !weekKey || (workOrder.signature !== null && isoWeekKeyOf(workOrder.signature.signedAt) === weekKey))
      .sort((a, b) => (a.signature?.signedAt.getTime() ?? 0) - (b.signature?.signedAt.getTime() ?? 0));

    if (workOrders.length === 0) {
      throw InvoiceBatchErrors.noPdfsToBundle();
    }

    const notReady = workOrders.filter((workOrder) => workOrder.pdfStatus !== 'PDF_READY' || !workOrder.pdfFileKey);
    if (notReady.length > 0) {
      throw InvoiceBatchErrors.pdfsNotReady(notReady.map((workOrder) => workOrder.workOrderNumber).sort());
    }

    const merged = await PDFDocument.create();
    for (const workOrder of workOrders) {
      // `notReady` hierboven garandeert al dat pdfFileKey niet null is — enkel voor TypeScript-narrowing.
      const file = await this.storage.read(workOrder.pdfFileKey!);
      const sourceDoc = await PDFDocument.load(file.data);
      const copiedPages = await merged.copyPages(sourceDoc, sourceDoc.getPageIndices());
      for (const page of copiedPages) {
        merged.addPage(page);
      }
    }
    const mergedBytes = await merged.save();

    const periodSuffix = weekKey ? weekKey.replace('-', '_') : batch.periodLabel.replace(/[^0-9A-Za-z]+/g, '_');
    const fileName = `Werkbonnen_${slugify(batch.customer.name)}_${periodSuffix}.pdf`;

    return { fileName, data: Buffer.from(mergedBytes) };
  }
}

/** Zelfde formule als teamleader-invoice.service.ts's isoWeekKeyOf (ISO-8601, maandag als eerste dag) — bewust lokaal gehouden, zelfde patroon als computeWorkedSeconds elders in deze codebase. */
function isoWeekKeyOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (d.getUTCDay() + 6) % 7; // maandag = 0
  d.setUTCDate(d.getUTCDate() - dayNumber + 3); // donderdag van deze ISO-week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNumber + 3);
  const weekNumber = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}
