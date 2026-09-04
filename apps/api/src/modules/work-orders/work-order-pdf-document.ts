import { createElement as h } from 'react';

/**
 * Phase 8 — PDF-opbouw (sectie 12 van de projectbrief). Pure functie: bouwt
 * de PDF-buffer op uit reeds-opgehaalde data (geen Prisma/StorageService
 * hier) — de orchestratie (data ophalen, statussen bijwerken, opslaan) zit
 * in work-order-pdf.service.ts.
 *
 * Twee bewuste, aan elkaar gerelateerde keuzes hieronder:
 *
 * 1. `React.createElement` i.p.v. JSX: dit is een pure Node/TypeScript
 *    backend zonder JSX-compilatie ingesteld (geen `.tsx`/`jsx`-tsconfig-
 *    optie) — dat zo laten vermijdt elke wijziging aan de build-configuratie
 *    voor deze ene, verder geïsoleerde module.
 *
 * 2. `@react-pdf/renderer` (`"type": "module"`, puur ESM, geen CJS-build)
 *    wordt hier bewust via een dynamische `import()` geladen i.p.v. een
 *    gewone top-level `import` — apps/api is zelf CommonJS (`"type":
 *    "commonjs"` in package.json), en `tsc` weigert terecht een statische
 *    `import` die tot een `require()` van een ESM-only package zou
 *    compileren (TS1479). Een dynamische `import()` werkt wél vanuit CJS,
 *    ongeacht de Node-versie die Render toevallig draait — geen afhankelijkheid
 *    van het (nog vrij nieuwe, en hier niet expliciet vastgepinde) native
 *    `require(esm)`-gedrag. De module wordt één keer geladen en gecachet
 *    (`loadReactPdf()` hieronder).
 */

// `resolution-mode: 'import'` is nodig omdat dit een type-only verwijzing is
// naar een puur-ESM package vanuit een CommonJS-bestand (zie de toelichting
// hierboven) — zonder deze attribuut weigert tsc onder Node16-moduleresolutie
// te bepalen via welke package.json-"exports"-conditie de types opgelost
// moeten worden (TS1542).
type ReactPdfModule = typeof import('@react-pdf/renderer', { with: { 'resolution-mode': 'import' } });

let reactPdfModulePromise: Promise<ReactPdfModule> | null = null;
export function loadReactPdf(): Promise<ReactPdfModule> {
  if (!reactPdfModulePromise) {
    reactPdfModulePromise = import('@react-pdf/renderer');
  }
  return reactPdfModulePromise;
}

export interface PdfKit {
  View: ReactPdfModule['View'];
  Text: ReactPdfModule['Text'];
  Image: ReactPdfModule['Image'];
}

const GOLD = '#f0b90b';
const BLACK = '#0a0a0a';

/** Plain style-objecten — `StyleSheet.create()` is in @react-pdf/renderer optionele suiker, componenten aanvaarden gewoon platte objecten. */
const styles = {
  page: { paddingTop: 28, paddingBottom: 42, paddingHorizontal: 32, fontSize: 9, fontFamily: 'Helvetica', color: '#1a1a1a' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  logoBadge: { backgroundColor: BLACK, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'flex-start' },
  logoImage: { width: 110, height: 48, objectFit: 'contain' },
  logoText: { color: GOLD, fontSize: 16, fontFamily: 'Helvetica-Bold', letterSpacing: 2 },
  companyBlock: { marginTop: 6, fontSize: 8, color: '#444' },
  titleBlock: { alignItems: 'flex-end' },
  titleText: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: BLACK },
  workOrderNumber: { fontSize: 11, color: GOLD, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  dateText: { fontSize: 8, color: '#666', marginTop: 2 },
  partiesRow: { flexDirection: 'row', marginBottom: 14 },
  partyBlock: { flex: 1, borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4, padding: 10 },
  partyBlockSpacer: { width: 12 },
  partyLabel: { fontSize: 7, textTransform: 'uppercase', color: GOLD, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
  partyName: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: BLACK },
  partyLine: { fontSize: 8, color: '#444', marginTop: 2 },
  sectionLabel: { fontSize: 8, textTransform: 'uppercase', color: GOLD, fontFamily: 'Helvetica-Bold', marginBottom: 6, marginTop: 14 },
  descriptionText: { fontSize: 9, lineHeight: 1.4, color: '#222' },
  table: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4 },
  tableHeaderRow: { flexDirection: 'row', backgroundColor: '#f5f5f5', paddingVertical: 5, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  tableTotalRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: BLACK },
  colEmployee: { flex: 2, fontSize: 8 },
  colTime: { flex: 1, fontSize: 8, textAlign: 'right' },
  tableHeaderText: { fontSize: 7, textTransform: 'uppercase', color: '#666', fontFamily: 'Helvetica-Bold' },
  totalLabel: { flex: 3, fontSize: 9, fontFamily: 'Helvetica-Bold', textAlign: 'right', paddingRight: 8 },
  totalValue: { flex: 1, fontSize: 9, fontFamily: 'Helvetica-Bold', color: GOLD, textAlign: 'right' },
  photosGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 4 },
  photoCell: { width: '48%', marginBottom: 12 },
  photoImage: { width: '100%', height: 150, objectFit: 'cover', borderRadius: 4 },
  photoCaption: { fontSize: 7, color: '#666', marginTop: 3 },
  approvalBlock: { marginTop: 16, borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 4, padding: 12 },
  signatureImage: { width: 180, height: 70, objectFit: 'contain', marginBottom: 6 },
  signerName: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: BLACK },
  signerMeta: { fontSize: 7, color: '#666', marginTop: 1 },
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

/** Mensentaal-labels — zelfde waarden als WORK_ORDER_PHOTO_CATEGORY_LABELS in shared-types (hier lokaal gehouden i.p.v. geïmporteerd, om deze module niet onnodig te koppelen aan de frontend-gerichte constante). */
const PHOTO_CATEGORY_LABELS: Record<string, string> = {
  SITUATIE_VOOR: 'Situatie voor werken',
  UITVOERING: 'Uitvoering',
  SITUATIE_NA: 'Situatie na werken',
  SERIENUMMER: 'Serienummer',
  TECHNISCHE_INSTALLATIE: 'Technische installatie',
  PROBLEEM_SCHADE: 'Probleem/schade',
  OVERIGE: 'Overige',
};

export interface WorkOrderPdfPhotoData {
  data: Buffer;
  mimeType: string;
  category: string | null;
  description: string | null;
}

export interface WorkOrderPdfTimeEntryData {
  employeeDisplayName: string;
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
}

export interface WorkOrderPdfData {
  workOrderNumber: string;
  customerName: string;
  projectName: string;
  projectNumber: string | null;
  projectAddress: string | null;
  description: string | null;
  /** Op vraag (4/9/2026) — zie de toelichting bij work-order-pdf.service.ts se buildPdfData(). `null` = km-vergoeding niet van toepassing, toont dan geen aparte regel. */
  kmAmountCents: number | null;
  kmDistanceOneWayMeters: number | null;
  timeEntries: WorkOrderPdfTimeEntryData[];
  photos: WorkOrderPdfPhotoData[];
  signature: {
    signerName: string;
    signerFunction: string | null;
    signedAt: Date;
    image: { data: Buffer; mimeType: string };
  };
  company: {
    companyName: string;
    addressLine: string | null;
    vatNumber: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    logo: { data: Buffer; mimeType: string } | null;
    legalText: string;
  };
}

export async function renderWorkOrderPdf(data: WorkOrderPdfData): Promise<Buffer> {
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
        buildParties(kit, data),
        ...(data.description ? [buildDescription(kit, data.description)] : []),
        buildHoursTable(kit, data),
        ...(data.photos.length > 0 ? [buildPhotos(kit, data.photos)] : []),
        buildApproval(kit, data.signature),
        buildFooter(kit, data.company.legalText),
      ),
    ),
  );
  return Buffer.from(buffer);
}

function buildHeader({ View, Text, Image }: PdfKit, data: WorkOrderPdfData) {
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
      h(Text, { style: styles.titleText }, 'WERKBON'),
      h(Text, { style: styles.workOrderNumber }, data.workOrderNumber),
      h(Text, { style: styles.dateText }, formatDate(data.signature.signedAt)),
    ),
  );
}

function buildParties({ View, Text }: PdfKit, data: WorkOrderPdfData) {
  return h(
    View,
    { style: styles.partiesRow },
    h(
      View,
      { style: styles.partyBlock },
      h(Text, { style: styles.partyLabel }, 'Klant'),
      h(Text, { style: styles.partyName }, data.customerName),
      ...(data.projectAddress ? [h(Text, { key: 'addr', style: styles.partyLine }, data.projectAddress)] : []),
    ),
    h(View, { style: styles.partyBlockSpacer }),
    h(
      View,
      { style: styles.partyBlock },
      h(Text, { style: styles.partyLabel }, 'Project'),
      h(Text, { style: styles.partyName }, data.projectName),
      ...(data.projectNumber
        ? [h(Text, { key: 'num', style: styles.partyLine }, `Projectnr. ${data.projectNumber}`)]
        : []),
    ),
  );
}

function buildDescription({ View, Text }: PdfKit, description: string) {
  return h(
    View,
    null,
    h(Text, { style: styles.sectionLabel }, 'Uitgevoerde werkzaamheden'),
    h(Text, { style: styles.descriptionText }, description),
  );
}

function buildHoursTable({ View, Text }: PdfKit, data: WorkOrderPdfData) {
  let totalSeconds = 0;
  const rows = data.timeEntries.map((entry, index) => {
    const workedSeconds = computeWorkedSeconds(entry);
    totalSeconds += workedSeconds;
    return h(
      View,
      { key: String(index), style: styles.tableRow },
      h(Text, { style: styles.colEmployee }, entry.employeeDisplayName),
      h(Text, { style: styles.colTime }, formatTime(entry.startedAt)),
      h(Text, { style: styles.colTime }, entry.endedAt ? formatTime(entry.endedAt) : '—'),
      h(Text, { style: styles.colTime }, formatHm(entry.pausedSeconds)),
      h(Text, { style: styles.colTime }, formatHm(workedSeconds)),
    );
  });

  return h(
    View,
    null,
    h(Text, { style: styles.sectionLabel }, 'Urenstaat'),
    h(
      View,
      { style: styles.table },
      h(
        View,
        { style: styles.tableHeaderRow },
        h(Text, { style: [styles.colEmployee, styles.tableHeaderText] }, 'Werknemer'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Van'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Tot'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Pauze'),
        h(Text, { style: [styles.colTime, styles.tableHeaderText] }, 'Uren'),
      ),
      ...rows,
      h(
        View,
        { style: styles.tableTotalRow },
        h(Text, { style: styles.totalLabel }, 'Totaal factureerbare uren'),
        h(Text, { style: styles.totalValue }, formatHm(totalSeconds)),
      ),
    ),
    buildKmCompensation({ View, Text }, data),
  );
}

/**
 * Op vraag (4/9/2026): "km-vergoeding op de werkbon zelf tonen, niet enkel op
 * de factuur" — voorheen enkel zichtbaar als aparte "verplaatsingskosten"-
 * regel op de Teamleader-conceptfactuur (TeamleaderInvoiceService), nooit op
 * de PDF die de klant effectief ter plaatse ondertekent. Toont niets (geen
 * lege/nul-regel) wanneer er geen km-vergoeding van toepassing is. Bewust
 * geëxporteerd (i.p.v. lokaal in buildHoursTable() gehouden) zodat dit
 * rechtstreeks, zonder een volledige PDF te moeten renderen/parsen, getest
 * kan worden — zie test/work-order-pdf-document.test.ts.
 */
export function buildKmCompensation({ View, Text }: Pick<PdfKit, 'View' | 'Text'>, data: WorkOrderPdfData) {
  if (!data.kmAmountCents || data.kmDistanceOneWayMeters == null) {
    return null;
  }
  const roundTripKm = Math.round((data.kmDistanceOneWayMeters * 2) / 1000);
  return h(
    View,
    { style: styles.tableTotalRow },
    h(Text, { style: styles.totalLabel }, `Verplaatsingskosten (${roundTripKm} km heen-terug)`),
    h(Text, { style: styles.totalValue }, formatEuro(data.kmAmountCents)),
  );
}

function formatEuro(cents: number): string {
  return `€ ${(cents / 100).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildPhotos({ View, Text, Image }: PdfKit, photos: WorkOrderPdfPhotoData[]) {
  return h(
    View,
    null,
    h(Text, { style: styles.sectionLabel }, "Foto's"),
    h(
      View,
      { style: styles.photosGrid },
      ...photos.map((photo, index) => {
        const captionText = [photo.category ? (PHOTO_CATEGORY_LABELS[photo.category] ?? photo.category) : null, photo.description]
          .filter(Boolean)
          .join(' — ');
        return h(
          View,
          { key: String(index), style: styles.photoCell },
          h(Image, { src: photo.data, style: styles.photoImage }),
          captionText ? h(Text, { style: styles.photoCaption }, captionText) : null,
        );
      }),
    ),
  );
}

function buildApproval({ View, Text, Image }: PdfKit, signature: WorkOrderPdfData['signature']) {
  return h(
    View,
    { style: styles.approvalBlock, wrap: false },
    h(Text, { style: styles.sectionLabel }, 'Goedkeuring klant'),
    h(Image, { src: signature.image.data, style: styles.signatureImage }),
    h(Text, { style: styles.signerName }, signature.signerName),
    ...(signature.signerFunction ? [h(Text, { key: 'fn', style: styles.signerMeta }, signature.signerFunction)] : []),
    h(Text, { style: styles.signerMeta }, formatDateTime(signature.signedAt)),
  );
}

function buildFooter({ Text }: PdfKit, legalText: string) {
  return h(Text, { style: styles.footer, fixed: true }, legalText);
}

function computeWorkedSeconds(entry: WorkOrderPdfTimeEntryData): number {
  if (!entry.endedAt) return 0;
  const raw = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000 - entry.pausedSeconds;
  return Math.max(0, raw);
}

/** Formaat "7:30" — zelfde als het voorbeeld in sectie 8 van de projectbrief (bewust anders dan de "7u 30min"-weergave in de app-UI). */
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

function formatDateTime(date: Date): string {
  return `${formatDate(date)} om ${formatTime(date)}`;
}
