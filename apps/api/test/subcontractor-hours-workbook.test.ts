import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildSubcontractorHoursWorkbook } from '../src/modules/hours-export/subcontractor-hours-workbook';
import type { HoursExportSubcontractorDetail } from '../src/modules/hours-export/hours-export.service';

const detail: HoursExportSubcontractorDetail = {
  employeeId: 'emp-1',
  displayName: 'Jan Onderaannemer',
  periodLabel: '2026-08',
  totalSeconds: 4 * 3600 + 2 * 3600,
  totalNormalHours: 5,
  totalOvertimeHours: 1,
  projects: [
    {
      projectName: 'Onderhoud HVAC',
      projectNumber: 'PRO-1',
      customerName: 'Janssens BV',
      totalSeconds: 4 * 3600,
      totalNormalHours: 3,
      totalOvertimeHours: 1,
      entries: [
        {
          timeEntryId: 'te-wo-1',
        workOrderId: 'wo-1',
          workOrderNumber: 'WB-2026-000123',
          projectName: 'Onderhoud HVAC',
          projectNumber: 'PRO-1',
          customerName: 'Janssens BV',
          signedAt: new Date('2026-08-10T16:00:00Z'),
          startedAt: new Date('2026-08-10T08:00:00Z'),
          endedAt: new Date('2026-08-10T12:00:00Z'),
          pausedSeconds: 0,
          isManual: false,
          description: 'Onderhoud uitgevoerd.',
          normalHours: 3,
          overtimeHours: 1,
        },
      ],
    },
    {
      projectName: 'Interventie',
      projectNumber: null,
      customerName: 'De Smet NV',
      totalSeconds: 2 * 3600,
      totalNormalHours: 2,
      totalOvertimeHours: 0,
      entries: [
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
  ],
};

describe('buildSubcontractorHoursWorkbook()', () => {
  it('genereert een geldig .xlsx-bestand met de juiste normale-uren-/overuren-totalen', async () => {
    const buffer = await buildSubcontractorHoursWorkbook(detail);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    // Buffer-type-mismatch tussen mogelijk twee verschillende @types/node-
    // versies in de dependency-boom (ExcelJS' eigen typedefinities vs. de
    // root-@types/node) — een `unknown`-cast volstond niet (de twee
    // `Buffer`-declaraties zijn structureel verschillend), dus hier bewust
    // `any` om dat volledig te omzeilen; enkel in deze test, niet in
    // productiecode.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Urenoverzicht');
    expect(sheet).toBeDefined();

    const allValues = sheet!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .filter((v) => v !== undefined && v !== null);

    expect(allValues).toContain('Onderhoud HVAC — Janssens BV');
    expect(allValues).toContain('Interventie — De Smet NV');
    expect(allValues).toContain('WB-2026-000123');
    expect(allValues).toContain('WB-2026-000124');
    expect(allValues).toContain(3); // normaal, project 1 (regel + subtotaal)
    expect(allValues).toContain(1); // overuren, project 1 (regel + subtotaal)
    expect(allValues).toContain(2); // normaal, project 2 (regel + subtotaal)
    expect(allValues).toContain(5); // eindtotaal normaal
  });
});
