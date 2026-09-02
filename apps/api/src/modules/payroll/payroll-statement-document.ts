import { createElement as h } from 'react';
import type { PayrollBatchRecord } from '../payroll/payroll.service';

/**
 * Personeelsuitbetaling — totalisatie-met-detail-document per medewerker/
 * onderaannemer/periode (op vraag, 1/9/2026: "mooie tabel met per dag
 * beginuur, einduur, pauze en totaal gewerkte uren + overuren"). Grotendeels
 * dezelfde opbouw/stijl als subcontractor-statement-document.ts (bewust
 * lokaal gehouden i.p.v. gedeeld, zie de toelichting daar) — hier bewust
 * NIET gebaseerd op een verse herberekening, maar op de al BEVROREN
 * PayrollBatch-data (business rule 3-analoog: een afgesloten uitbetaling
 * verandert niet met terugwerkende kracht als een tarief later wijzigt).
 */
type ReactPdfModule = typeof import('@react-pdf/renderer', { with: { 'resolution-mode': 'import' } });

let reactPdfModulePromise: Promise<ReactPdfModule> | null = null;
function loadReactPdf(): Promise<ReactPdfModule> {
  if (!reactPdfModulePromise) {
    reactPdfModulePromise = import('@react-pdf/renderer');
  }
  return reactPdfModulePromise;
}

interface PdfKit {
  View: ReactPdfModule['View'];
  Text: ReactPdfModule['Text'];
  Image: ReactPdfModule['Image'];
}

const GOLD = '#f0b90b';
const BLACK = '#0a0a0a';

/** Zelfde stijl als subcontractor-statement-document.ts (bewust — zelfde huisstijl/lay-out), bewust lokaal gehouden. */
const styles = {
  page: { paddingTop: 28, paddingBottom: 42, paddingHorizontal: 32, fontSize: 9, fontFamily: 'Helvetica', color: '#1a1a1a' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  logoBadge: { backgroundColor: BLACK, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'flex-start' },
  logoImage: { width: 110, height: 48, objectFit: 'contain' },
  logoText: { color: GOLD, fontSize: 16, fontFamily: 'Helvetica-Bold', letterSpacing: 2 },
  companyBlock: { marginTop: 6, fontSize: 8, color: '#444' },
  titleBlock: { alignItems: 'flex-end' },
  titleText: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: BLACK },
  subtitleText: { fontSize: 11, color: GOLD, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  dateText: { fontSize: 8, color: '#666', marginTop: 2 },
  partyBlock: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4, padding: 10, marginBottom: 14 },
  partyLabel: { fontSize: 7, textTransform: 'uppercase', color: GOLD, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
  partyName: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: BLACK },
  projectBlock: { marginBottom: 14 },
  projectHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  projectName: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: BLACK },
  projectTotal: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: GOLD },
  table: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4 },
  tableHeaderRow: { flexDirection: 'row', backgroundColor: '#f5f5f5', paddingVertical: 5, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  colDate: { flex: 1.1, fontSize: 8 },
  colWorkOrder: { flex: 1.3, fontSize: 8 },
  colTime: { flex: 0.8, fontSize: 8, textAlign: 'right' },
  colPremium: { flex: 1, fontSize: 8, textAlign: 'right' },
  colAmount: { flex: 1, fontSize: 8, textAlign: 'right' },
  tableHeaderText: { fontSize: 7, textTransform: 'uppercase', color: '#666', fontFamily: 'Helvetica-Bold' },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: BLACK,
  },
  grandTotalLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: BLACK },
  grandTotalValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: GOLD },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 32,
    right: 32,
    fontSize: 7,
    color: '#888',
    textAlign: 'center',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 6,
  },
} as const;

export interface PayrollStatementCompanyData {
  companyName: string;
  addressLine: string | null;
  vatNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  logo: { data: Buffer; mimeType: string } | null;
}

interface ProjectGroup {
  projectName: string;
  lines: PayrollBatchRecord['lines'];
  normalHours: number;
  overtimeHours: number;
  amountCents: number;
}

export async function renderPayrollStatementPdf(batch: PayrollBatchRecord, company: PayrollStatementCompanyData): Promise<Buffer> {
  const { Document, Page, View, Text, Image, renderToBuffer } = await loadReactPdf();
  const kit: PdfKit = { View, Text, Image };
  const groups = groupByProject(batch);

  const buffer = await renderToBuffer(
    h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', style: styles.page },
        buildHeader(kit, batch, company),
        buildParty(kit, batch),
        ...groups.map((group, index) => buildProject(kit, group, index)),
        buildGrandTotal(kit, batch.totalAmountCents),
        buildFooter(
          kit,
          'Dit overzicht toont het bevroren, effectief uitbetaalde bedrag per tijdregistratie op het moment van afsluiten — een latere wijziging van tarief of toeslagregeling heeft hier geen invloed meer op.',
        ),
      ),
    ),
  );
  return Buffer.from(buffer);
}

function groupByProject(batch: PayrollBatchRecord): ProjectGroup[] {
  const byProject = new Map<string, ProjectGroup>();
  for (const line of batch.lines) {
    const existing = byProject.get(line.projectName);
    if (existing) {
      existing.lines.push(line);
      existing.normalHours += line.normalHours;
      existing.overtimeHours += line.overtimeHours;
      existing.amountCents += line.amountCents;
    } else {
      byProject.set(line.projectName, {
        projectName: line.projectName,
        lines: [line],
        normalHours: line.normalHours,
        overtimeHours: line.overtimeHours,
        amountCents: line.amountCents,
      });
    }
  }
  return Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function buildHeader({ View, Text, Image }: PdfKit, batch: PayrollBatchRecord, company: PayrollStatementCompanyData) {
  return h(
    View,
    { style: styles.headerRow },
    h(
      View,
      null,
      company.logo
        ? h(Image, { src: company.logo.data, style: styles.logoImage })
        : h(View, { style: styles.logoBadge }, h(Text, { style: styles.logoText }, 'UURIVO')),
      h(
        View,
        { style: styles.companyBlock },
        h(Text, null, company.companyName),
        ...(company.addressLine ? [h(Text, { key: 'addr' }, company.addressLine)] : []),
        ...(company.vatNumber ? [h(Text, { key: 'vat' }, `BTW ${company.vatNumber}`)] : []),
        ...(company.contactEmail || company.contactPhone
          ? [h(Text, { key: 'contact' }, [company.contactEmail, company.contactPhone].filter(Boolean).join(' · '))]
          : []),
      ),
    ),
    h(
      View,
      { style: styles.titleBlock },
      h(Text, { style: styles.titleText }, 'PERSONEELSUITBETALING'),
      h(Text, { style: styles.subtitleText }, formatPeriodLabel(batch.periodLabel)),
      h(Text, { style: styles.dateText }, `Afgesloten op ${formatDate(batch.closedAt ?? batch.createdAt)}`),
    ),
  );
}

function buildParty({ View, Text }: PdfKit, batch: PayrollBatchRecord) {
  return h(
    View,
    { style: styles.partyBlock },
    h(Text, { style: styles.partyLabel }, 'Medewerker / onderaannemer'),
    h(Text, { style: styles.partyName }, batch.employeeDisplayName),
  );
}

function buildProject({ View, Text }: PdfKit, group: ProjectGroup, index: number) {
  const rows = group.lines.map((line, lineIndex) =>
    h(
      View,
      { key: String(lineIndex), style: styles.tableRow },
      h(Text, { style: styles.colDate }, formatDate(line.startedAt)),
      h(Text, { style: styles.colWorkOrder }, line.workOrderNumber),
      h(Text, { style: styles.colTime }, formatTime(line.startedAt)),
      h(Text, { style: styles.colTime }, formatTime(line.endedAt)),
      h(Text, { style: styles.colTime }, formatHm(line.pausedSeconds)),
      h(Text, { style: styles.colTime }, formatHours(line.normalHours)),
      h(Text, { style: styles.colTime }, formatHours(line.overtimeHours)),
      h(Text, { style: styles.colPremium }, premiumLabel(line.premiumType)),
      h(Text, { style: styles.colAmount }, formatEuro(line.amountCents)),
    ),
  );

  return h(
    View,
    { key: String(index), style: styles.projectBlock, wrap: false },
    h(
      View,
      { style: styles.projectHeaderRow },
      h(Text, { style: styles.projectName }, group.projectName),
      h(Text, { style: styles.projectTotal }, formatEuro(group.amountCents)),
    ),
    h(
      View,
      { style: styles.table },
      h(
        View,
        { style: styles.tableHeaderRow },
        h(Text, { style: [styles.colDate, styles.tableHeaderText] }, 'Datum'),
        h(Text, { style: [styles.colWorkOrder, styles.tableHeaderText] }, 'Werkbon'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Van'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Tot'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Pauze'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Normaal'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Overuren'),
        h(Text, { style: [styles.colPremium, styles.tableHeaderText] }, 'Toeslag'),
        h(Text, { style: [styles.colAmount, styles.tableHeaderText] }, 'Bedrag'),
      ),
      ...rows,
    ),
  );
}

function buildGrandTotal({ View, Text }: PdfKit, totalAmountCents: number) {
  return h(
    View,
    { style: styles.grandTotalRow },
    h(Text, { style: styles.grandTotalLabel }, 'Totaal uit te betalen'),
    h(Text, { style: styles.grandTotalValue }, formatEuro(totalAmountCents)),
  );
}

function buildFooter({ Text }: PdfKit, legalText: string) {
  return h(Text, { style: styles.footer, fixed: true }, legalText);
}

function premiumLabel(premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK'): string {
  return premiumType === 'NONE' ? '—' : premiumType === 'SHIFT_WORK' ? 'Ploegenwerk' : 'Nachtwerk';
}

function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function formatHours(hours: number): string {
  return hours.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatEuro(cents: number): string {
  return `€ ${(cents / 100).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatPeriodLabel(periodLabel: string): string {
  const [year, month] = periodLabel.split('-');
  if (!year || !month) return periodLabel;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
}
