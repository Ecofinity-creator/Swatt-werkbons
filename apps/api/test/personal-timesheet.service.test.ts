import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { computeDayRows, type TimesheetRawEntry } from '../src/modules/hours-export/personal-timesheet.service';
import { fillPersonalTimesheetTemplate } from '../src/modules/hours-export/personal-timesheet-workbook';

/**
 * Klantvraag 10/9/2026 — export naar het persoonlijke jaaroverzicht-sjabloon
 * ("Uren registratie 2026 leeg basis document.xlsx"). computeDayRows() is de
 * kern-businesslogica (per-dag groeperen + Start/Einde/Pauze/Vertrek/
 * Aankomst/KM/Project/Opmerkingen berekenen) — hieronder puur getest, los
 * van Prisma/ExcelJS. Onderaan een integratietest die het echte, meegeleverde
 * sjabloonbestand laadt en controleert dat de juiste cellen gevuld worden
 * zonder de bestaande formules aan te raken.
 */

function workOrder(overrides: Partial<NonNullable<TimesheetRawEntry['workOrder']>> = {}): NonNullable<TimesheetRawEntry['workOrder']> {
  return {
    id: 'wo-1',
    description: 'Onderhoud uitgevoerd.',
    kmDistanceOneWayMeters: 12000,
    projectName: 'Onderhoud warmtepomp',
    customerName: 'Janssens BV',
    ...overrides,
  };
}

/** Zie de toelichting bij de integratietest onderaan: ExcelJS geeft een tijd-cel terug als Date t.o.v. de Excel-epoch. */
function excelTimeCellToHours(value: unknown): number {
  if (!(value instanceof Date)) throw new Error(`Verwachtte een Date-waarde voor een tijd-cel, kreeg: ${String(value)}`);
  return value.getUTCHours() + value.getUTCMinutes() / 60 + value.getUTCSeconds() / 3600;
}

function entry(overrides: Partial<TimesheetRawEntry> = {}): TimesheetRawEntry {
  return {
    activityType: 'PROJECT_WORK',
    startedAt: new Date(2026, 7, 10, 8, 0, 0),
    endedAt: new Date(2026, 7, 10, 16, 0, 0),
    pausedSeconds: 0,
    workOrder: workOrder(),
    ...overrides,
  };
}

describe('computeDayRows()', () => {
  it('vult Start/Einde/Pauze/KM/Project/Opmerkingen voor één enkele PROJECT_WORK-registratie', () => {
    const rows = computeDayRows([
      entry({
        startedAt: new Date(2026, 7, 10, 8, 0, 0),
        endedAt: new Date(2026, 7, 10, 16, 30, 0),
        pausedSeconds: 30 * 60, // 30 min pauze
      }),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.month).toBe(7); // augustus (0-based)
    expect(row.dayOfMonth).toBe(10);
    expect(row.startFraction).toBeCloseTo(8 / 24, 5);
    expect(row.endFraction).toBeCloseTo(16.5 / 24, 5);
    expect(row.pauzeFraction).toBeCloseTo(0.5 / 24, 5); // 30 min
    expect(row.project).toBe('Janssens BV - Onderhoud warmtepomp');
    expect(row.opmerkingen).toBe('Onderhoud uitgevoerd.');
    expect(row.kmHeen).toBeCloseTo(12, 5);
    expect(row.kmTerug).toBeCloseTo(12, 5);
    expect(row.vertrekFraction).toBeNull();
    expect(row.aankomstFraction).toBeNull();
  });

  it('meerdere PROJECT_WORK-registraties dezelfde dag: Start = vroegste, Einde = laatste, Pauze absorbeert het tussenliggende gat', () => {
    const rows = computeDayRows([
      entry({
        startedAt: new Date(2026, 7, 10, 8, 0, 0),
        endedAt: new Date(2026, 7, 10, 10, 0, 0), // 2u gewerkt
        pausedSeconds: 0,
        workOrder: workOrder({ id: 'wo-1', projectName: 'Werf A', kmDistanceOneWayMeters: 5000 }),
      }),
      entry({
        startedAt: new Date(2026, 7, 10, 13, 0, 0),
        endedAt: new Date(2026, 7, 10, 16, 0, 0), // 3u gewerkt
        pausedSeconds: 0,
        workOrder: workOrder({ id: 'wo-2', projectName: 'Werf B', kmDistanceOneWayMeters: 7000 }),
      }),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.startFraction).toBeCloseTo(8 / 24, 5);
    expect(row.endFraction).toBeCloseTo(16 / 24, 5);
    // Totale span = 8u, effectief gewerkt = 5u -> 3u "pauze" (incl. het gat tussen de 2 werven)
    expect(row.pauzeFraction).toBeCloseTo(3 / 24, 5);
    expect(row.project).toBe('Janssens BV - Werf A; Janssens BV - Werf B');
    expect(row.kmHeen).toBeCloseTo(12, 5); // 5 + 7 km
  });

  it('TRAVEL-registraties die de werkdag omkaderen vullen Vertrek/Aankomst', () => {
    const rows = computeDayRows([
      entry({ startedAt: new Date(2026, 7, 10, 8, 0, 0), endedAt: new Date(2026, 7, 10, 16, 0, 0) }),
      entry({
        activityType: 'TRAVEL',
        startedAt: new Date(2026, 7, 10, 7, 30, 0),
        endedAt: new Date(2026, 7, 10, 8, 0, 0),
        workOrder: null,
      }),
      entry({
        activityType: 'TRAVEL',
        startedAt: new Date(2026, 7, 10, 16, 0, 0),
        endedAt: new Date(2026, 7, 10, 16, 20, 0),
        workOrder: null,
      }),
    ]);

    const row = rows[0]!;
    expect(row.vertrekFraction).toBeCloseTo(7.5 / 24, 5);
    expect(row.aankomstFraction).toBeCloseTo(16.333333 / 24, 4);
  });

  it('een TRAVEL-registratie die NIET voor de werkdag start blijft ongebruikt (Vertrek blijft leeg)', () => {
    const rows = computeDayRows([
      entry({ startedAt: new Date(2026, 7, 10, 8, 0, 0), endedAt: new Date(2026, 7, 10, 16, 0, 0) }),
      entry({
        activityType: 'TRAVEL',
        startedAt: new Date(2026, 7, 10, 9, 0, 0), // ná Start -> "omkadert" de werkdag niet
        endedAt: new Date(2026, 7, 10, 9, 30, 0),
        workOrder: null,
      }),
    ]);

    const row = rows[0]!;
    expect(row.vertrekFraction).toBeNull();
  });

  it('een dag zonder PROJECT_WORK (enkel TRAVEL) laat Start/Einde/Vertrek/Aankomst leeg — bekende sjabloonbeperking', () => {
    const rows = computeDayRows([
      entry({
        activityType: 'TRAVEL',
        startedAt: new Date(2026, 7, 10, 8, 0, 0),
        endedAt: new Date(2026, 7, 10, 9, 0, 0),
        workOrder: null,
      }),
    ]);

    const row = rows[0]!;
    expect(row.startFraction).toBeNull();
    expect(row.endFraction).toBeNull();
    expect(row.vertrekFraction).toBeNull();
    expect(row.aankomstFraction).toBeNull();
  });

  it('groepeert correct per kalenderdag, ook over meerdere maanden heen', () => {
    const rows = computeDayRows([
      entry({ startedAt: new Date(2026, 0, 5, 8, 0, 0), endedAt: new Date(2026, 0, 5, 16, 0, 0) }),
      entry({ startedAt: new Date(2026, 11, 24, 8, 0, 0), endedAt: new Date(2026, 11, 24, 12, 0, 0) }),
    ]);

    expect(rows).toHaveLength(2);
    const jan = rows.find((r) => r.month === 0)!;
    const dec = rows.find((r) => r.month === 11)!;
    expect(jan.dayOfMonth).toBe(5);
    expect(dec.dayOfMonth).toBe(24);
  });

  it('werkbon zonder km-vergoeding (kmDistanceOneWayMeters null) laat KM-kolommen leeg', () => {
    const rows = computeDayRows([entry({ workOrder: workOrder({ kmDistanceOneWayMeters: null }) })]);
    expect(rows[0]!.kmHeen).toBeNull();
    expect(rows[0]!.kmTerug).toBeNull();
  });
});

describe('fillPersonalTimesheetTemplate() — integratie met het echte sjabloonbestand', () => {
  it('vult naam + dagrij in zonder de bestaande formules te overschrijven', async () => {
    const rows = computeDayRows([
      entry({
        startedAt: new Date(2026, 0, 15, 8, 0, 0), // 15 januari
        endedAt: new Date(2026, 0, 15, 16, 30, 0),
        pausedSeconds: 30 * 60,
      }),
    ]);

    const buffer = await fillPersonalTimesheetTemplate('Peter Janssens', rows);

    const workbook = new ExcelJS.Workbook();
    // Bekende typings-mismatch tussen recentere @types/node (Buffer<ArrayBufferLike>)
    // en exceljs' eigen, tegen een oudere @types/node-versie geschreven
    // Buffer-parameter — functioneel identiek (beide zijn gewoon een Buffer),
    // enkel de generieke parameter verschilt. `any` is hier bewust, puur om
    // deze omgevingsmismatch te omzeilen in test-code.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);

    const basisgegevens = workbook.getWorksheet('Basisgegevens')!;
    expect(basisgegevens.getCell('D1').value).toBe('Peter Janssens');

    const jan = workbook.getWorksheet('Jan')!;
    const row = jan.getRow(17); // 3 (eerste dagrij) + 15 - 1
    // ExcelJS leest een cel met een tijd-celopmaak terug als Date (Excel-epoch
    // 1899-12-30 + tijdfractie) i.p.v. de ruwe fractie die we geschreven hebben
    // — vandaar de omzetting hieronder i.p.v. rechtstreeks een fractie te vergelijken.
    expect(excelTimeCellToHours(row.getCell('D').value)).toBeCloseTo(8, 5); // Start
    expect(excelTimeCellToHours(row.getCell('E').value)).toBeCloseTo(16.5, 5); // Einde
    expect(excelTimeCellToHours(row.getCell('G').value)).toBeCloseTo(0.5, 5); // Pauze
    expect(row.getCell('T').value).toBe('Janssens BV - Onderhoud warmtepomp');
    expect(row.getCell('U').value).toBe('Onderhoud uitgevoerd.');
    expect(row.getCell('R').value).toBeCloseTo(12, 5);

    // De weekdag-formule (kolom A) van diezelfde rij mag niet aangeraakt zijn
    // — nog steeds een (gedeelde) formulecel, met "Donderdag" als gecachte
    // uitkomst (15/1/2026 is een donderdag), i.p.v. een losse tekstwaarde.
    const weekdayCell = row.getCell('A') as unknown as { value: { formula?: string; sharedFormula?: string; result?: string } };
    expect(weekdayCell.value.sharedFormula ?? weekdayCell.value.formula).toBeTruthy();
    expect(weekdayCell.value.result).toBe('Donderdag');

    // Een dag zonder registratie (bv. 16 januari) blijft volledig leeg.
    const emptyRow = jan.getRow(18);
    expect(emptyRow.getCell('D').value).toBeNull();
  });
});
