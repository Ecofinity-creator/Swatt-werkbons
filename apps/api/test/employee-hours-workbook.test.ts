import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildEmployeeHoursWorkbook } from '../src/modules/hours-export/employee-hours-workbook';
import type { HoursExportEmployeeDetail } from '../src/modules/hours-export/hours-export.service';

const employees: HoursExportEmployeeDetail[] = [
  {
    employeeId: 'emp-1',
    displayName: 'Peter Janssens',
    entries: [
      {
        timeEntryId: 'te-wo-1',
        workOrderId: 'wo-1',
        workOrderNumber: 'WB-2026-000123',
        projectName: 'Onderhoud HVAC',
        projectNumber: 'PRO-1',
        customerName: 'Janssens BV',
        signedAt: new Date('2026-08-10T16:00:00Z'),
        startedAt: new Date('2026-08-10T07:00:00Z'),
        endedAt: new Date('2026-08-10T16:30:00Z'),
        pausedSeconds: 0,
        isManual: false,
        description: null,
        normalHours: 8,
        overtimeHours: 1.5,
      },
      {
        timeEntryId: 'te-wo-2',
        workOrderId: 'wo-2',
        workOrderNumber: 'WB-2026-000124',
        projectName: 'Interventie',
        projectNumber: null,
        customerName: 'De Smet NV',
        signedAt: new Date('2026-08-12T14:00:00Z'),
        startedAt: new Date('2026-08-12T08:00:00Z'),
        endedAt: new Date('2026-08-12T10:00:00Z'),
        pausedSeconds: 0,
        isManual: false,
        description: null,
        normalHours: 2,
        overtimeHours: 0,
      },
    ],
  },
];

describe('buildEmployeeHoursWorkbook()', () => {
  it('splitst normale uren/overuren in zowel het Overzicht-blad als het detailblad per medewerker', async () => {
    const buffer = await buildEmployeeHoursWorkbook('2026-08', employees);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);

    const overview = workbook.getWorksheet('Overzicht');
    expect(overview).toBeDefined();
    const overviewValues = overview!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .filter((v) => v !== undefined && v !== null);
    expect(overviewValues).toContain('Normaal (u)');
    expect(overviewValues).toContain('Overuren (u)');
    expect(overviewValues).toContain(10); // 8 + 2 uur normaal, over beide projecten heen
    expect(overviewValues).toContain(1.5);

    const employeeSheet = workbook.getWorksheet('Peter Janssens');
    expect(employeeSheet).toBeDefined();
    const employeeValues = employeeSheet!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .filter((v) => v !== undefined && v !== null);
    expect(employeeValues).toContain('WB-2026-000123');
    expect(employeeValues).toContain(8);
    expect(employeeValues).toContain(1.5);
    expect(employeeValues).toContain('Totaal');
  });

  it('groepeert het detailblad per project met een subtotaal per project — "in dezelfde zin als de tabel onderaannemers" (3/9/2026)', async () => {
    const buffer = await buildEmployeeHoursWorkbook('2026-08', employees);
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);

    const sheet = workbook.getWorksheet('Peter Janssens')!;
    const values = sheet
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .filter((v) => v !== undefined && v !== null);

    // Beide projecten met hun klant als groepskop, exact zoals bij onderaannemers.
    expect(values).toContain('Onderhoud HVAC — Janssens BV');
    expect(values).toContain('Interventie — De Smet NV');
    expect(values).toContain('WB-2026-000124');
    // Subtotaal per project (8/1,5 voor project 1, 2/0 voor project 2) + eindtotaal (10/1,5).
    expect(values).toContain('Subtotaal');
    expect(values.filter((v) => v === 'Totaal')).toHaveLength(1); // enkel het eindtotaal, niet per project
    expect(values).toContain(10); // eindtotaal normale uren (8+2)
  });
});
