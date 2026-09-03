import ExcelJS from 'exceljs';
import type { HoursExportEmployeeDetail, HoursExportEntryRecord } from './hours-export.service';

/**
 * Werknemer vs. Onderaannemer — Excel-urenexport voor eigen medewerkers
 * (EmploymentType.EMPLOYEE), sectie "Nieuw: Werknemer vs. Onderaannemer" in
 * claude/projectoverdracht-samenvatting_2.md: "uren-export naar Excel".
 *
 * Fase 12-herziening (3/9/2026): "pas de tabel werknemers aan in dezelfde
 * zin als de tabel onderaannemers" — het detailblad per medewerker is nu
 * gegroepeerd per project/werf (met subtotaal per project + eindtotaal),
 * exact dezelfde opbouw als subcontractor-hours-workbook.ts, i.p.v. één
 * platte lijst. Het "Overzicht"-blad (alle medewerkers samen, met
 * kruistotalen) blijft ongewijzigd — dat heeft geen tegenhanger bij
 * onderaannemers, die worden altijd één-voor-één gedownload.
 */
export async function buildEmployeeHoursWorkbook(
  periodLabel: string,
  employees: HoursExportEmployeeDetail[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Uurivo';
  workbook.created = new Date();
  workbook.subject = `Urenexport ${periodLabel}`;
  workbook.title = `Urenexport ${periodLabel}`;

  const overviewSheet = workbook.addWorksheet('Overzicht');
  overviewSheet.columns = [
    { header: 'Medewerker', key: 'displayName', width: 32 },
    { header: 'Aantal werkbonnen', key: 'workOrderCount', width: 18 },
    { header: 'Normaal (u)', key: 'normalHours', width: 14 },
    { header: 'Overuren (u)', key: 'overtimeHours', width: 14 },
  ];
  styleHeaderRow(overviewSheet);
  for (const employee of employees) {
    const totalNormalHours = employee.entries.reduce((sum, entry) => sum + entry.normalHours, 0);
    const totalOvertimeHours = employee.entries.reduce((sum, entry) => sum + entry.overtimeHours, 0);
    overviewSheet.addRow({
      displayName: employee.displayName,
      workOrderCount: new Set(employee.entries.map((entry) => entry.workOrderId)).size,
      normalHours: Number(totalNormalHours.toFixed(2)),
      overtimeHours: Number(totalOvertimeHours.toFixed(2)),
    });
  }

  for (const employee of employees) {
    const sheet = workbook.addWorksheet(sheetNameFor(employee.displayName, workbook));
    sheet.columns = [
      { key: 'a', width: 12 },
      { key: 'b', width: 16 },
      { key: 'c', width: 24 },
      { key: 'd', width: 10 },
      { key: 'e', width: 10 },
      { key: 'f', width: 12 },
      { key: 'g', width: 12 },
      { key: 'h', width: 12 },
    ];

    const titleRow = sheet.addRow([`Urenoverzicht — ${employee.displayName}`]);
    titleRow.font = { bold: true, size: 14 };
    sheet.addRow([`Periode: ${formatPeriodLabel(periodLabel)}`]).font = { italic: true, color: { argb: 'FF666666' } };
    sheet.addRow([]);

    let employeeTotalNormalHours = 0;
    let employeeTotalOvertimeHours = 0;
    for (const project of groupByProject(employee.entries)) {
      employeeTotalNormalHours += project.totalNormalHours;
      employeeTotalOvertimeHours += project.totalOvertimeHours;

      const projectHeaderRow = sheet.addRow([`${project.projectName} — ${project.customerName}`]);
      projectHeaderRow.font = { bold: true, size: 11 };
      sheet.mergeCells(projectHeaderRow.number, 1, projectHeaderRow.number, 8);

      const columnHeaderRow = sheet.addRow(['Datum', 'Werkbon', 'Omschrijving', 'Van', 'Tot', 'Pauze (min)', 'Normaal (u)', 'Overuren (u)']);
      styleColumnHeaderRow(columnHeaderRow);

      for (const entry of project.entries) {
        sheet.addRow([
          formatDate(entry.startedAt),
          entry.workOrderNumber,
          entry.description ?? '',
          formatTime(entry.startedAt),
          formatTime(entry.endedAt),
          Math.round(entry.pausedSeconds / 60),
          Number(entry.normalHours.toFixed(2)),
          Number(entry.overtimeHours.toFixed(2)),
        ]);
      }

      const subtotalRow = sheet.addRow([
        '',
        '',
        '',
        '',
        '',
        'Subtotaal',
        Number(project.totalNormalHours.toFixed(2)),
        Number(project.totalOvertimeHours.toFixed(2)),
      ]);
      subtotalRow.font = { bold: true };
      sheet.addRow([]);
    }

    const totalRow = sheet.addRow(['', '', '', '', '', 'Totaal', Number(employeeTotalNormalHours.toFixed(2)), Number(employeeTotalOvertimeHours.toFixed(2))]);
    totalRow.font = { bold: true, size: 12 };
    totalRow.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
    totalRow.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
    totalRow.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

interface ProjectGroup {
  projectName: string;
  customerName: string;
  entries: HoursExportEntryRecord[];
  totalNormalHours: number;
  totalOvertimeHours: number;
}

/** Zelfde groeperingslogica als HoursExportService.getSubcontractorDetail() (bewust lokaal gehouden, zie de toelichting daar). */
function groupByProject(entries: HoursExportEntryRecord[]): ProjectGroup[] {
  const byProject = new Map<string, ProjectGroup>();
  for (const entry of entries) {
    const key = `${entry.projectName}::${entry.projectNumber ?? ''}`;
    const existing = byProject.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.totalNormalHours += entry.normalHours;
      existing.totalOvertimeHours += entry.overtimeHours;
    } else {
      byProject.set(key, {
        projectName: entry.projectName,
        customerName: entry.customerName,
        entries: [entry],
        totalNormalHours: entry.normalHours,
        totalOvertimeHours: entry.overtimeHours,
      });
    }
  }
  const groups = Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  for (const group of groups) {
    group.entries.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
  return groups;
}

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
}

function styleColumnHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  });
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
