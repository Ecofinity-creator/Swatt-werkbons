import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildSubcontractorHoursWorkbook } from '../src/modules/hours-export/subcontractor-hours-workbook';
import type { HoursExportSubcontractorDetail } from '../src/modules/hours-export/hours-export.service';

const detail: HoursExportSubcontractorDetail = {
  employeeId: 'emp-1',
  displayName: 'Jan Onderaannemer',
  periodLabel: '2026-08',
  totalSeconds: 4 * 3600 + 2 * 3600,
  projects: [
    {
      projectName: 'Onderhoud HVAC',
      projectNumber: 'PRO-1',
      customerName: 'Janssens BV',
      totalSeconds: 4 * 3600,
      entries: [
        {
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
        },
      ],
    },
    {
      projectName: 'Interventie',
      projectNumber: null,
      customerName: 'De Smet NV',
      totalSeconds: 2 * 3600,
      entries: [
        {
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
        },
      ],
    },
  ],
};

describe('buildSubcontractorHoursWorkbook()', () => {
  it('genereert een geldig, niet-leeg .xlsx-bestand met de juiste totalen', async () => {
    const buffer = await buildSubcontractorHoursWorkbook(detail);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
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
    expect(allValues).toContain(4); // subtotaal project 1 (4u)
    expect(allValues).toContain(2); // subtotaal project 2 (2u)
    expect(allValues).toContain(6); // eindtotaal (6u)
  });
});
