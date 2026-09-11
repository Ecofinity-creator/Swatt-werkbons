import path from 'node:path';
import ExcelJS from 'exceljs';
import type { PersonalTimesheetDayValue } from './personal-timesheet.service';

/**
 * Vult het door de klant aangeleverde Excel-sjabloon (10/9/2026 —
 * "Uren registratie 2026 leeg basis document.xlsx", ongewijzigd bewaard als
 * apps/api/assets/personal-timesheet-template-2026.xlsx) in met de
 * berekende dagwaarden uit personal-timesheet.service.ts.
 *
 * Belangrijk: dit vult ENKEL de ruwe invoercellen (start/einde, pauze,
 * vertrek/aankomst, km, project, opmerkingen) — alle andere cellen
 * (weekdag, gewerkte uren, overuren, kostprijs, weektotalen, ...) bevatten
 * al formules in het sjabloon zelf en worden hier bewust niet aangeraakt;
 * Excel berekent die automatisch opnieuw zodra het bestand geopend wordt.
 * Verlof-/afwezigheidscodes (kolom H) blijven altijd leeg — zie de
 * toelichting in personal-timesheet.service.ts.
 */

const TEMPLATE_PATH = path.join(__dirname, '../../../assets/personal-timesheet-template-2026.xlsx');

/** Sjabloon-tabbladnamen in kalendervolgorde — Jan!B3 = Basisgegevens!B1 (1/1), elke volgende maand cascadeert daarvandaan (bv. Feb!B3 = Jan!B33+1). */
const MONTH_SHEET_NAMES = ['Jan', 'Feb', 'Maa', 'Apr', 'Mei', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'] as const;

/** Eerste dagrij per maandtabblad is altijd rij 3 (rij 1/2 = kopteksten). */
const FIRST_DAY_ROW = 3;

export async function fillPersonalTimesheetTemplate(
  employeeDisplayName: string,
  dayRows: PersonalTimesheetDayValue[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);

  const basisgegevens = workbook.getWorksheet('Basisgegevens');
  if (!basisgegevens) {
    throw new Error('Sjabloon "Basisgegevens"-tabblad ontbreekt — beschadigd sjabloonbestand?');
  }
  basisgegevens.getCell('D1').value = employeeDisplayName;

  for (const day of dayRows) {
    const sheetName = MONTH_SHEET_NAMES[day.month];
    if (!sheetName) continue; // defensief — day.month komt uit Date.getMonth(), altijd 0-11
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;

    const row = sheet.getRow(FIRST_DAY_ROW + day.dayOfMonth - 1);

    // C/D/E/F/G/I zijn al geformatteerd als tijd (h:mm) in het sjabloon —
    // een fractie (0..1 = seconden/86400) volstaat, Excel toont dat correct
    // volgens de bestaande celopmaak.
    if (day.vertrekFraction != null) row.getCell('C').value = day.vertrekFraction;
    if (day.startFraction != null) row.getCell('D').value = day.startFraction;
    if (day.endFraction != null) row.getCell('E').value = day.endFraction;
    if (day.aankomstFraction != null) row.getCell('F').value = day.aankomstFraction;
    if (day.pauzeFraction != null) row.getCell('G').value = day.pauzeFraction;

    if (day.kmHeen != null) row.getCell('R').value = day.kmHeen;
    if (day.kmTerug != null) row.getCell('S').value = day.kmTerug;
    if (day.project != null) row.getCell('T').value = day.project;
    if (day.opmerkingen != null) row.getCell('U').value = day.opmerkingen;

    row.commit();
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
