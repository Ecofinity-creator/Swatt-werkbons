import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { renderPayrollStatementPdf } from '../src/modules/payroll/payroll-statement-document';
import { buildPayrollStatementWorkbook } from '../src/modules/payroll/payroll-statement-workbook';
import type { PayrollBatchRecord } from '../src/modules/payroll/payroll.service';

const batch: PayrollBatchRecord = {
  id: 'batch-1',
  employeeId: 'emp-1',
  employeeDisplayName: 'Peter Janssens',
  periodLabel: '2026-08',
  status: 'CLOSED',
  totalAmountCents: 8 * 6500 * 1.5 + 2 * 6500 * 2.0, // zelfde scenario als het acceptatiecriterium uit het ontwerp
  createdAt: new Date('2026-09-01T08:00:00Z'),
  closedAt: new Date('2026-09-01T08:05:00Z'),
  lines: [
    {
      id: 'line-1',
      timeEntryId: 'te-1',
      projectName: 'Onderhoud HVAC',
      workOrderNumber: 'WB-2026-000123',
      startedAt: new Date('2026-08-10T06:00:00Z'),
      endedAt: new Date('2026-08-10T14:00:00Z'),
      pausedSeconds: 1800,
      normalHours: 8,
      overtimeHours: 0,
      premiumType: 'NIGHT_WORK',
      amountCents: Math.round(8 * 6500 * 1.5),
    },
    {
      id: 'line-2',
      timeEntryId: 'te-2',
      projectName: 'Onderhoud HVAC',
      workOrderNumber: 'WB-2026-000124',
      startedAt: new Date('2026-08-11T06:00:00Z'),
      endedAt: new Date('2026-08-11T08:00:00Z'),
      pausedSeconds: 0,
      normalHours: 0,
      overtimeHours: 2,
      premiumType: 'NIGHT_WORK',
      amountCents: Math.round(2 * 6500 * 2.0),
    },
  ],
};

describe('renderPayrollStatementPdf()', () => {
  it('genereert een geldig, niet-leeg PDF-bestand', async () => {
    const buffer = await renderPayrollStatementPdf(batch, {
      companyName: 'Uurivo',
      addressLine: null,
      vatNumber: null,
      contactEmail: null,
      contactPhone: null,
      logo: null,
    });
    expect(buffer.length).toBeGreaterThan(0);
    // PDF-bestanden beginnen altijd met de "%PDF-"-signatuur.
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('buildPayrollStatementWorkbook()', () => {
  it('genereert een geldig .xlsx-bestand met de juiste totalen en kolommen', async () => {
    const buffer = await buildPayrollStatementWorkbook(batch);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Personeelsuitbetaling');
    expect(sheet).toBeDefined();

    const allValues = sheet!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .filter((v) => v !== undefined && v !== null);

    expect(allValues).toContain('Onderhoud HVAC');
    expect(allValues).toContain('WB-2026-000123');
    expect(allValues).toContain('WB-2026-000124');
    expect(allValues).toContain('Nachtwerk');
    expect(allValues).toContain(8); // normale uren, regel 1
    expect(allValues).toContain(2); // overuren, regel 2
    expect(allValues).toContain(Number((batch.totalAmountCents / 100).toFixed(2)));
  });
});
