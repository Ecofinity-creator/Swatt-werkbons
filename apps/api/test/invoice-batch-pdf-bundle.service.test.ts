import type { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { InvoiceBatchPdfBundleService } from '../src/modules/invoice-batches/invoice-batch-pdf-bundle.service';
import type { StorageService } from '../src/modules/storage/storage.service';

/**
 * Unit-tests voor "werkbonnen exporteren per klant/per maand of per
 * klant/per week in 1 pdf" (klantvraag 10/9/2026). Elke individuele
 * werkbon-PDF blijft ongewijzigd — deze service plakt enkel de bestaande
 * pagina's samen (pdf-lib), dus de tests verifiëren vooral: welke
 * werkbonnen in scope komen (batch/week-filter, PDF-gereedheid) en dat de
 * samengevoegde PDF exact evenveel pagina's telt als de som van de
 * afzonderlijke PDF's.
 */

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  pdfStatus: string;
  pdfFileKey: string | null;
  signature: { signedAt: Date } | null;
}

interface FakeBatch {
  id: string;
  periodLabel: string;
  customer: { name: string };
  lines: Array<{ workOrder: FakeWorkOrder }>;
}

function createFakePrisma(batch: FakeBatch | null) {
  const prisma = {
    invoiceBatch: {
      findUnique: async ({ where }: { where: { id: string } }) => (batch && where.id === batch.id ? batch : null),
    },
  };
  return prisma as unknown as PrismaClient;
}

/** In-memory StorageService — bewaart per key gewoon de meegegeven PDF-bytes, zoals DatabaseStorageService dat via Postgres bytea zou doen. */
function createFakeStorage(files: Map<string, Buffer>): StorageService {
  return {
    save: async (data) => {
      const key = `key-${files.size}`;
      files.set(key, data);
      return key;
    },
    read: async (key) => {
      const data = files.get(key);
      if (!data) throw new Error(`onbekende key: ${key}`);
      return { mimeType: 'application/pdf', data };
    },
    delete: async (key) => {
      files.delete(key);
    },
  };
}

/** Bouwt een minimale, geldige PDF met `pageCount` lege pagina's — voor testdoeleinden identiek genoeg aan een echte werkbon-PDF. */
async function fakePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage();
  }
  return Buffer.from(await doc.save());
}

function workOrder(overrides: Partial<FakeWorkOrder> & { id: string }): FakeWorkOrder {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    pdfStatus: 'PDF_READY',
    pdfFileKey: `${overrides.id}-pdf`,
    signature: { signedAt: new Date('2026-08-10T10:00:00Z') },
    ...overrides,
  };
}

describe('InvoiceBatchPdfBundleService', () => {
  it('bundelt alle werkbon-PDFs van de batch tot één PDF (= "per maand", geen weekfilter)', async () => {
    const files = new Map<string, Buffer>();
    const storage = createFakeStorage(files);
    files.set('wo1-pdf', await fakePdf(2));
    files.set('wo2-pdf', await fakePdf(1));

    const batch: FakeBatch = {
      id: 'batch-1',
      periodLabel: '2026-08',
      customer: { name: 'Janssens BV' },
      lines: [{ workOrder: workOrder({ id: 'wo1' }) }, { workOrder: workOrder({ id: 'wo2', signature: { signedAt: new Date('2026-08-15T10:00:00Z') } }) }],
    };
    const service = new InvoiceBatchPdfBundleService(createFakePrisma(batch), storage);

    const result = await service.buildBundle('batch-1');

    const merged = await PDFDocument.load(result.data);
    expect(merged.getPageCount()).toBe(3); // 2 + 1 pagina's, ongewijzigd samengevoegd
    expect(result.fileName).toContain('Janssens');
    expect(result.fileName).toContain('2026_08');
  });

  it('filtert op ISO-week (ondertekeningsdatum) wanneer week meegegeven wordt', async () => {
    const files = new Map<string, Buffer>();
    const storage = createFakeStorage(files);
    files.set('wo1-pdf', await fakePdf(1)); // 10/08/2026 = ISO-week 32
    files.set('wo2-pdf', await fakePdf(1)); // 20/08/2026 = ISO-week 34

    const batch: FakeBatch = {
      id: 'batch-1',
      periodLabel: '2026-08',
      customer: { name: 'Janssens BV' },
      lines: [
        { workOrder: workOrder({ id: 'wo1', signature: { signedAt: new Date('2026-08-10T10:00:00Z') } }) },
        { workOrder: workOrder({ id: 'wo2', signature: { signedAt: new Date('2026-08-20T10:00:00Z') } }) },
      ],
    };
    const service = new InvoiceBatchPdfBundleService(createFakePrisma(batch), storage);

    const result = await service.buildBundle('batch-1', '2026-W34');

    const merged = await PDFDocument.load(result.data);
    expect(merged.getPageCount()).toBe(1); // enkel wo2
    expect(result.fileName).toContain('2026_W34');
  });

  it('weigert wanneer geen enkele werkbon in het gevraagde bereik valt', async () => {
    const batch: FakeBatch = {
      id: 'batch-1',
      periodLabel: '2026-08',
      customer: { name: 'Janssens BV' },
      lines: [{ workOrder: workOrder({ id: 'wo1', signature: { signedAt: new Date('2026-08-10T10:00:00Z') } }) }],
    };
    const service = new InvoiceBatchPdfBundleService(createFakePrisma(batch), createFakeStorage(new Map()));

    await expect(service.buildBundle('batch-1', '2026-W01')).rejects.toMatchObject({ code: 'INVOICE_BATCH_NO_PDFS_TO_BUNDLE' });
  });

  it('weigert wanneer één of meer werkbonnen in scope nog geen klare PDF hebben', async () => {
    const files = new Map<string, Buffer>();
    files.set('wo1-pdf', await fakePdf(1));
    const batch: FakeBatch = {
      id: 'batch-1',
      periodLabel: '2026-08',
      customer: { name: 'Janssens BV' },
      lines: [
        { workOrder: workOrder({ id: 'wo1' }) },
        { workOrder: workOrder({ id: 'wo2', pdfStatus: 'PDF_GENERATING', pdfFileKey: null }) },
      ],
    };
    const service = new InvoiceBatchPdfBundleService(createFakePrisma(batch), createFakeStorage(files));

    await expect(service.buildBundle('batch-1')).rejects.toMatchObject({ code: 'INVOICE_BATCH_PDFS_NOT_READY' });
  });

  it('weigert een onbestaande batch', async () => {
    const service = new InvoiceBatchPdfBundleService(createFakePrisma(null), createFakeStorage(new Map()));

    await expect(service.buildBundle('does-not-exist')).rejects.toMatchObject({ code: 'INVOICE_BATCH_NOT_FOUND' });
  });
});
