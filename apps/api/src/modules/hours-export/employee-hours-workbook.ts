import ExcelJS from 'exceljs';
import type { HoursExportEmployeeDetail } from './hours-export.service';

/**
 * Werknemer vs. Onderaannemer — Excel-urenexport voor eigen medewerkers
 * (EmploymentType.EMPLOYEE), sectie "Nieuw: Werknemer vs. Onderaannemer" in
 * claude/projectoverdracht-samenvatting_2.md: "uren-export naar Excel".
 * Bewust een ruwe urenlijst (één rij per tijdregistratie) — dit is het
 * tegenovergestelde van de totalisatie-met-detail-PDF voor onderaannemers
 * (zie subcontractor-statement-document.ts), bedoeld als brondata voor de
 * eigen loonverwerking i.p.v. een document dat naar een derde gestuurd wordt.
 *
 * Eén werkblad per medewerker (naast een "Overzicht"-blad met de totalen) —
 * zo kan de admin het bestand rechtstreeks doorsturen of per medewerker
 * kopiëren zonder eerst zelf te moeten filteren/sorteren.
 */
export async function buildEmployeeHoursWorkbook(
  periodLabel: string,
  employees: HoursExportEmployeeDetail[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Swatt Werkbon-app';
  workbook.created = new Date();
  workbook.subject = `Urenexport ${periodLabel}`;
  workbook.title = `Urenexport ${periodLabel}`;

  const overviewSheet = workbook.addWorksheet('Overzicht');
  overviewSheet.columns = [
    { header: 'Medewerker', key: 'displayName', width: 32 },
    { header: 'Aantal werkbonnen', key: 'workOrderCount', width: 18 },
    { header: 'Totaal uren', key: 'totalHours', width: 14 },
  ];
  styleHeaderRow(overviewSheet);
  for (const employee of employees) {
    const totalSeconds = employee.entries.reduce((sum, entry) => sum + workedSeconds(entry), 0);
    overviewSheet.addRow({
      displayName: employee.displayName,
      workOrderCount: new Set(employee.entries.map((entry) => entry.workOrderId)).size,
      totalHours: Number((totalSeconds / 3600).toFixed(2)),
    });
  }

  for (const employee of employees) {
    const sheet = workbook.addWorksheet(sheetNameFor(employee.displayName, workbook));
    sheet.columns = [
      { header: 'Datum', key: 'date', width: 12 },
      { header: 'Werkbon', key: 'workOrderNumber', width: 16 },
      { header: 'Klant', key: 'customerName', width: 24 },
      { header: 'Project', key: 'projectName', width: 28 },
      { header: 'Van', key: 'startTime', width: 8 },
      { header: 'Tot', key: 'endTime', width: 8 },
      { header: 'Pauze (min)', key: 'pauseMinutes', width: 12 },
      { header: 'Uren', key: 'hours', width: 10 },
      { header: 'Manueel', key: 'isManual', width: 10 },
    ];
    styleHeaderRow(sheet);

    let totalSeconds = 0;
    for (const entry of employee.entries) {
      const seconds = workedSeconds(entry);
      totalSeconds += seconds;
      sheet.addRow({
        date: formatDate(entry.startedAt),
        workOrderNumber: entry.workOrderNumber,
        customerName: entry.customerName,
        projectName: entry.projectName,
        startTime: formatTime(entry.startedAt),
        endTime: formatTime(entry.endedAt),
        pauseMinutes: Math.round(entry.pausedSeconds / 60),
        hours: Number((seconds / 3600).toFixed(2)),
        isManual: entry.isManual ? 'Ja' : 'Nee',
      });
    }

    const totalRow = sheet.addRow({ projectName: 'Totaal', hours: Number((totalSeconds / 3600).toFixed(2)) });
    totalRow.font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
}

/** Excel-werkbladnamen zijn max. 31 tekens en mogen geen `: \ / ? * [ ]` bevatten, en moeten uniek zijn binnen de workbook. */
function sheetNameFor(displayName: string, workbook: ExcelJS.Workbook): string {
  const base = displayName.replace(/[:\\/?*[\]]/g, ' ').slice(0, 28).trim() || 'Medewerker';
  let candidate = base;
  let suffix = 2;
  while (workbook.getWorksheet(candidate)) {
    candidate = `${base.slice(0, 28 - String(suffix).length - 1)} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

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
