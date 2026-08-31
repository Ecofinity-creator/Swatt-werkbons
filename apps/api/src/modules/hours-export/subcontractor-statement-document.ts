import { createElement as h } from 'react';

/**
 * Werknemer vs. Onderaannemer — totalisatie-met-detail-document per
 * onderaannemer/periode (claude/projectoverdracht-samenvatting_2.md,
 * sectie "Nieuw: Werknemer vs. Onderaannemer"): "bedoeld om naar de
 * onderaannemer te sturen zodat hij op basis daarvan zelf kan factureren —
 * dus een ander soort document dan de Excel-uren-export voor eigen
 * werknemers (totalisatie + detail, geen ruwe urenlijst)". Gegroepeerd per
 * werf/project, met per werf een totaal en de onderliggende data/uren.
 *
 * Zelfde `React.createElement`-/dynamische-import-aanpak als
 * work-order-pdf-document.ts — zie de uitgebreide toelichting daar (deze
 * module is een puur backend-bestand zonder JSX-compilatie, en
 * `@react-pdf/renderer` is ESM-only).
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

/** Grotendeels dezelfde stijl als work-order-pdf-document.ts (bewust — zelfde huisstijl), bewust lokaal gehouden i.p.v. gedeeld, zie de toelichting bij computeWorkedSeconds() daar. */
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
  projectCustomer: { fontSize: 8, color: '#666' },
  projectTotal: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: GOLD },
  table: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4 },
  tableHeaderRow: { flexDirection: 'row', backgroundColor: '#f5f5f5', paddingVertical: 5, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  colDate: { flex: 1, fontSize: 8 },
  colWorkOrder: { flex: 1.4, fontSize: 8 },
  colTime: { flex: 1, fontSize: 8, textAlign: 'right' },
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

export interface SubcontractorStatementEntryData {
  workOrderNumber: string;
  startedAt: Date;
  endedAt: Date;
  pausedSeconds: number;
}

export interface SubcontractorStatementProjectData {
  projectName: string;
  projectNumber: string | null;
  customerName: string;
  totalSeconds: number;
  entries: SubcontractorStatementEntryData[];
}

export interface SubcontractorStatementData {
  displayName: string;
  periodLabel: string;
  totalSeconds: number;
  projects: SubcontractorStatementProjectData[];
  company: {
    companyName: string;
    addressLine: string | null;
    vatNumber: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    logo: { data: Buffer; mimeType: string } | null;
  };
}

export async function renderSubcontractorStatementPdf(data: SubcontractorStatementData): Promise<Buffer> {
  const { Document, Page, View, Text, Image, renderToBuffer } = await loadReactPdf();
  const kit: PdfKit = { View, Text, Image };

  const buffer = await renderToBuffer(
    h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', style: styles.page },
        buildHeader(kit, data),
        buildParty(kit, data),
        ...data.projects.map((project, index) => buildProject(kit, project, index)),
        buildGrandTotal(kit, data.totalSeconds),
        buildFooter(
          kit,
          'Dit overzicht is een totalisatie van de door Swatt geregistreerde en door de klant ondertekende werkbonnen voor deze periode, bedoeld als basis voor uw eigen facturatie.',
        ),
      ),
    ),
  );
  return Buffer.from(buffer);
}

function buildHeader({ View, Text, Image }: PdfKit, data: SubcontractorStatementData) {
  return h(
    View,
    { style: styles.headerRow },
    h(
      View,
      null,
      data.company.logo
        ? h(Image, { src: data.company.logo.data, style: styles.logoImage })
        : h(View, { style: styles.logoBadge }, h(Text, { style: styles.logoText }, 'UURIVO')),
      h(
        View,
        { style: styles.companyBlock },
        h(Text, null, data.company.companyName),
        ...(data.company.addressLine ? [h(Text, { key: 'addr' }, data.company.addressLine)] : []),
        ...(data.company.vatNumber ? [h(Text, { key: 'vat' }, `BTW ${data.company.vatNumber}`)] : []),
        ...(data.company.contactEmail || data.company.contactPhone
          ? [
              h(
                Text,
                { key: 'contact' },
                [data.company.contactEmail, data.company.contactPhone].filter(Boolean).join(' · '),
              ),
            ]
          : []),
      ),
    ),
    h(
      View,
      { style: styles.titleBlock },
      h(Text, { style: styles.titleText }, 'URENOVERZICHT ONDERAANNEMER'),
      h(Text, { style: styles.subtitleText }, data.periodLabel),
      h(Text, { style: styles.dateText }, `Gegenereerd op ${formatDate(new Date())}`),
    ),
  );
}

function buildParty({ View, Text }: PdfKit, data: SubcontractorStatementData) {
  return h(
    View,
    { style: styles.partyBlock },
    h(Text, { style: styles.partyLabel }, 'Onderaannemer'),
    h(Text, { style: styles.partyName }, data.displayName),
  );
}

function buildProject({ View, Text }: PdfKit, project: SubcontractorStatementProjectData, index: number) {
  const rows = project.entries.map((entry, entryIndex) => {
    const seconds = workedSeconds(entry);
    return h(
      View,
      { key: String(entryIndex), style: styles.tableRow },
      h(Text, { style: styles.colDate }, formatDate(entry.startedAt)),
      h(Text, { style: styles.colWorkOrder }, entry.workOrderNumber),
      h(Text, { style: styles.colTime }, formatTime(entry.startedAt)),
      h(Text, { style: styles.colTime }, formatTime(entry.endedAt)),
      h(Text, { style: styles.colTime }, formatHm(entry.pausedSeconds)),
      h(Text, { style: styles.colTime }, formatHm(seconds)),
    );
  });

  return h(
    View,
    { key: String(index), style: styles.projectBlock, wrap: false },
    h(
      View,
      { style: styles.projectHeaderRow },
      h(
        View,
        null,
        h(Text, { style: styles.projectName }, project.projectName),
        h(
          Text,
          { style: styles.projectCustomer },
          [project.customerName, project.projectNumber ? `#${project.projectNumber}` : null].filter(Boolean).join(' · '),
        ),
      ),
      h(Text, { style: styles.projectTotal }, formatHm(project.totalSeconds)),
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
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Uren'),
      ),
      ...rows,
    ),
  );
}

function buildGrandTotal({ View, Text }: PdfKit, totalSeconds: number) {
  return h(
    View,
    { style: styles.grandTotalRow },
    h(Text, { style: styles.grandTotalLabel }, 'Totaal alle werven'),
    h(Text, { style: styles.grandTotalValue }, formatHm(totalSeconds)),
  );
}

function buildFooter({ Text }: PdfKit, legalText: string) {
  return h(Text, { style: styles.footer, fixed: true }, legalText);
}

function workedSeconds(entry: { startedAt: Date; endedAt: Date; pausedSeconds: number }): number {
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
