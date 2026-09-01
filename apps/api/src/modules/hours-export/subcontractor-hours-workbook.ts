import ExcelJS from 'exceljs';
import type { HoursExportSubcontractorDetail } from './hours-export.service';

/**
 * Werknemer vs. Onderaannemer — Excel-variant van de totalisatie-met-detail
 * voor één onderaannemer/periode (zie subcontractor-statement-document.ts
 * voor de PDF-versie, die deze Excel-versie inhoudelijk spiegelt: gegroepeerd
 * per werf/project, met per werf een subtotaal en de onderliggende
 * tijdregistraties, en een eindtotaal onderaan). Op uitdrukkelijke vraag
 * (steven, 1/9/2026): "totalisatie downloadbaar in Excel, PDF mag blijven" —
 * dus bewust een aanvulling naast de bestaande PDF-route, geen vervanging.
 */
export async function buildSubcontractorHoursWorkbook(detail: HoursExportSubcontractorDetail): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Uurivo';
  workbook.created = new Date();
  workbook.subject = `Urenoverzicht ${detail.displayName} — ${detail.periodLabel}`;
  workbook.title = `Urenoverzicht ${detail.displayName} — ${detail.periodLabel}`;

  const sheet = workbook.addWorksheet('Urenoverzicht');
  sheet.columns = [
    { key: 'a', width: 12 },
    { key: 'b', width: 16 },
    { key: 'c', width: 24 },
    { key: 'd', width: 10 },
    { key: 'e', width: 10 },
    { key: 'f', width: 12 },
    { key: 'g', width: 10 },
  ];

  const titleRow = sheet.addRow([`Urenoverzicht — ${detail.displayName}`]);
  titleRow.font = { bold: true, size: 14 };
  sheet.addRow([`Periode: ${formatPeriodLabel(detail.periodLabel)}`]).font = { italic: true, color: { argb: 'FF666666' } };
  sheet.addRow([]);

  for (const project of detail.projects) {
    const projectHeaderRow = sheet.addRow([`${project.projectName} — ${project.customerName}`]);
    projectHeaderRow.font = { bold: true, size: 11 };
    sheet.mergeCells(projectHeaderRow.number, 1, projectHeaderRow.number, 7);

    const columnHeaderRow = sheet.addRow(['Datum', 'Werkbon', 'Omschrijving', 'Van', 'Tot', 'Pauze (min)', 'Uren']);
    styleColumnHeaderRow(columnHeaderRow);

    for (const entry of project.entries) {
      const seconds = workedSeconds(entry);
      sheet.addRow([
        formatDate(entry.startedAt),
        entry.workOrderNumber,
        entry.description ?? '',
        formatTime(entry.startedAt),
        formatTime(entry.endedAt),
        Math.round(entry.pausedSeconds / 60),
        Number((seconds / 3600).toFixed(2)),
      ]);
    }

    const subtotalRow = sheet.addRow(['', '', '', '', '', 'Subtotaal', Number((project.totalSeconds / 3600).toFixed(2))]);
    subtotalRow.font = { bold: true };
    sheet.addRow([]);
  }

  const totalRow = sheet.addRow(['', '', '', '', '', 'Totaal', Number((detail.totalSeconds / 3600).toFixed(2))]);
  totalRow.font = { bold: true, size: 12 };
  totalRow.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
  totalRow.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function styleColumnHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  });
}

/** Zelfde formule als hours-export.service.ts — bewust lokaal gehouden, zie de toelichting daar. */
function workedSeconds(entry: { startedAt: Date; endedAt: Date; pausedSeconds: number }): number {
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

function formatPeriodLabel(periodLabel: string): string {
  const [year, month] = periodLabel.split('-');
  if (!year || !month) return periodLabel;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
}
