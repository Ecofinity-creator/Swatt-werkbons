import ExcelJS from 'exceljs';
import type { PayrollBatchRecord } from './payroll.service';

/**
 * Excel-variant van de personeelsuitbetaling — spiegelt
 * payroll-statement-document.ts (PDF): gegroepeerd per project, per regel
 * datum/werkbon/van/tot/pauze/normale uren/overuren/toeslag/bedrag, met een
 * subtotaal per project en een eindtotaal. Gebaseerd op de al bevroren
 * PayrollBatch-data, niet op een verse herberekening.
 */
export async function buildPayrollStatementWorkbook(batch: PayrollBatchRecord): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Uurivo';
  workbook.created = new Date();
  workbook.subject = `Personeelsuitbetaling ${batch.employeeDisplayName} — ${batch.periodLabel}`;
  workbook.title = `Personeelsuitbetaling ${batch.employeeDisplayName} — ${batch.periodLabel}`;

  const sheet = workbook.addWorksheet('Personeelsuitbetaling');
  sheet.columns = [
    { key: 'a', width: 12 },
    { key: 'b', width: 16 },
    { key: 'c', width: 10 },
    { key: 'd', width: 10 },
    { key: 'e', width: 10 },
    { key: 'f', width: 10 },
    { key: 'g', width: 10 },
    { key: 'h', width: 14 },
    { key: 'i', width: 12 },
  ];

  const titleRow = sheet.addRow([`Personeelsuitbetaling — ${batch.employeeDisplayName}`]);
  titleRow.font = { bold: true, size: 14 };
  sheet.addRow([`Periode: ${formatPeriodLabel(batch.periodLabel)}`]).font = { italic: true, color: { argb: 'FF666666' } };
  sheet.addRow([`Afgesloten op: ${formatDate(batch.closedAt ?? batch.createdAt)}`]).font = { italic: true, color: { argb: 'FF666666' } };
  sheet.addRow([]);

  const groups = groupByProject(batch);
  for (const group of groups) {
    const projectHeaderRow = sheet.addRow([group.projectName]);
    projectHeaderRow.font = { bold: true, size: 11 };
    sheet.mergeCells(projectHeaderRow.number, 1, projectHeaderRow.number, 9);

    const columnHeaderRow = sheet.addRow(['Datum', 'Werkbon', 'Van', 'Tot', 'Pauze (min)', 'Normaal (u)', 'Overuren (u)', 'Toeslag', 'Bedrag']);
    styleColumnHeaderRow(columnHeaderRow);

    for (const line of group.lines) {
      sheet.addRow([
        formatDate(line.startedAt),
        line.workOrderNumber,
        formatTime(line.startedAt),
        formatTime(line.endedAt),
        Math.round(line.pausedSeconds / 60),
        Number(line.normalHours.toFixed(2)),
        Number(line.overtimeHours.toFixed(2)),
        premiumLabel(line.premiumType),
        Number((line.amountCents / 100).toFixed(2)),
      ]);
    }

    const subtotalRow = sheet.addRow(['', '', '', '', '', '', '', 'Subtotaal', Number((group.amountCents / 100).toFixed(2))]);
    subtotalRow.font = { bold: true };
    sheet.addRow([]);
  }

  const totalRow = sheet.addRow(['', '', '', '', '', '', '', 'Totaal uit te betalen', Number((batch.totalAmountCents / 100).toFixed(2))]);
  totalRow.font = { bold: true, size: 12 };
  totalRow.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
  totalRow.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

interface ProjectGroup {
  projectName: string;
  lines: PayrollBatchRecord['lines'];
  amountCents: number;
}

function groupByProject(batch: PayrollBatchRecord): ProjectGroup[] {
  const byProject = new Map<string, ProjectGroup>();
  for (const line of batch.lines) {
    const existing = byProject.get(line.projectName);
    if (existing) {
      existing.lines.push(line);
      existing.amountCents += line.amountCents;
    } else {
      byProject.set(line.projectName, { projectName: line.projectName, lines: [line], amountCents: line.amountCents });
    }
  }
  return Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function styleColumnHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  });
}

function premiumLabel(premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK'): string {
  return premiumType === 'NONE' ? '—' : premiumType === 'SHIFT_WORK' ? 'Ploegenwerk' : 'Nachtwerk';
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
