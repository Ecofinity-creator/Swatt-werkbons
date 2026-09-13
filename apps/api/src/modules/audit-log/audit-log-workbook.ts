import ExcelJS from 'exceljs';
import { AUDIT_LOG_ACTION_LABELS } from '@swatt/shared-types';
import type { AuditLogRecord } from './audit-log.service';

/**
 * Klantvraag 13/9/2026 — "een doorzoekbare auditlog-UI... sterk richting
 * bedrijven die met aanbestedingen of verzekeringsvereisten werken". Een
 * scherm alleen volstaat niet voor dat gebruik: een aanbesteding/verzekeraar
 * wil een exporteerbaar, dateerbaar bewijsstuk kunnen opvragen, niet enkel
 * live doorklikken in de app. Zelfde opbouw als employee-hours-workbook.ts
 * (ExcelJS, goudgele header — huisstijl-conventie in deze codebase).
 *
 * Bewust chronologisch oplopend (oudste eerst) i.p.v. het "nieuwste eerst"
 * van het scherm zelf — een auditor leest doorgaans van begin naar einde.
 */
export async function buildAuditLogWorkbook(entries: AuditLogRecord[], filterDescription: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Uurivo';
  workbook.created = new Date();
  workbook.subject = 'Auditlog-export';
  workbook.title = 'Auditlog';

  const sheet = workbook.addWorksheet('Auditlog');
  sheet.columns = [
    { header: 'Datum/tijd', key: 'createdAt', width: 20 },
    { header: 'Actie', key: 'action', width: 32 },
    { header: 'Actiecode', key: 'actionCode', width: 30 },
    { header: 'Door', key: 'actor', width: 26 },
    { header: 'Type', key: 'entityType', width: 18 },
    { header: 'Entiteit-ID', key: 'entityId', width: 38 },
    { header: 'Details', key: 'metadata', width: 60 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };

  for (const entry of entries) {
    sheet.addRow({
      createdAt: entry.createdAt.toLocaleString('nl-BE'),
      action: AUDIT_LOG_ACTION_LABELS[entry.action] ?? entry.action,
      actionCode: entry.action,
      actor: entry.actorUser?.employee?.displayName ?? entry.actorUser?.email ?? 'Systeem',
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : '',
    });
  }
  sheet.getRow(1).alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Kort infoblad met de toegepaste filters — belangrijk voor een
  // aanbesteding/verzekeraar om te kunnen zien dat dit geen willekeurige,
  // onvolledige greep is, maar een exact afgebakende export.
  const infoSheet = workbook.addWorksheet('Over deze export');
  infoSheet.columns = [
    { header: 'Veld', key: 'field', width: 22 },
    { header: 'Waarde', key: 'value', width: 60 },
  ];
  const infoHeaderRow = infoSheet.getRow(1);
  infoHeaderRow.font = { bold: true };
  infoHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0B90B' } };
  infoSheet.addRow({ field: 'Geëxporteerd op', value: new Date().toLocaleString('nl-BE') });
  infoSheet.addRow({ field: 'Toegepaste filters', value: filterDescription });
  infoSheet.addRow({ field: 'Aantal rijen', value: entries.length });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
