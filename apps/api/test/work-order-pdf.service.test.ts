import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors';
import { buildPdfFileName, WorkOrderPdfService } from '../src/modules/work-orders/work-order-pdf.service';

/**
 * Unit-tests met een minimale fake-Prisma + fake StorageService/CompanySettingsService/
 * WorkOrderService — zelfde patroon als work-order-photo.service.test.ts en
 * work-order-signature.service.test.ts. `renderWorkOrderPdf` zelf wordt NIET
 * gemockt: dit draait de echte @react-pdf/renderer-render (snel, deterministisch,
 * geen netwerk), zodat deze test ook echt bewijst dat de volledige
 * generate()-flow end-to-end werkt, niet enkel de orchestratie eromheen.
 */

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

function createFakeWorkOrder(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date('2026-08-24T10:00:00.000Z');
  const started = new Date('2026-08-24T08:00:00.000Z');
  return {
    id: 'wo-1',
    workOrderNumber: 'WB-2026-000123',
    projectId: 'project-1',
    status: 'SIGNED',
    description: 'Onderhoud uitgevoerd.',
    createdByEmployeeId: 'employee-1',
    createdAt: started,
    updatedAt: now,
    pdfStatus: 'PDF_PENDING',
    pdfFileKey: null,
    pdfFileName: null,
    pdfGeneratedAt: null,
    pdfError: null,
    // Op vraag (4/9/2026) — expliciet null i.p.v. weggelaten, zodat deze
    // fixture realistisch overeenkomt met een echte Prisma-rij (die geeft
    // altijd `null` terug voor een lege kolom, nooit `undefined`).
    kmAmountCents: null,
    project: {
      name: 'Onderhoud warmtepomp',
      projectNumber: 'PRO-42',
      address: 'Kerkstraat 1, 9000 Gent',
      kmDistanceOneWayMeters: null,
      customer: { name: 'Janssens BV', address: 'Kerkstraat 1, 9000 Gent', vatNumber: 'BE0123456789' },
    },
    createdByEmployee: { displayName: 'Peter' },
    timeEntries: [
      {
        id: 'link-1',
        timeEntry: {
          id: 'te-1',
          employeeId: 'employee-1',
          startedAt: started,
          endedAt: now,
          pausedSeconds: 1800,
          employee: { displayName: 'Peter' },
        },
      },
    ],
    photos: [],
    signature: {
      id: 'sig-1',
      signerName: 'Jan Janssens',
      signerFunction: 'Zaakvoerder',
      signatureFileKey: 'signature-key',
      signedAt: now,
      contentHash: 'hash',
      requestedByUserId: 'user-1',
    },
    ...overrides,
  };
}

function createFakeStorage(overrides: { save?: ReturnType<typeof vi.fn>; read?: ReturnType<typeof vi.fn> } = {}) {
  return {
    save: overrides.save ?? vi.fn().mockResolvedValue('pdf-key'),
    read: overrides.read ?? vi.fn().mockResolvedValue({ mimeType: 'image/png', data: PNG_1X1 }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeCompanySettings() {
  return {
    get: vi.fn().mockResolvedValue({
      id: 'company-1',
      companyName: 'Ecofinity',
      addressLine: 'Voorbeeldstraat 1, 1000 Brussel',
      vatNumber: 'BE0123456789',
      contactEmail: 'info@ecofinity.eu',
      contactPhone: null,
      logoFileKey: null,
      workOrderLegalText: 'De klant bevestigt door ondertekening de hierboven vermelde uitgevoerde werkzaamheden.',
    }),
  };
}

describe('buildPdfFileName()', () => {
  it('bouwt een ASCII-veilige bestandsnaam op (sectie 12-formaat)', () => {
    const fileName = buildPdfFileName('WB-2026-000123', 'Janssens BV', 'Onderhoud Warmtepomp');
    expect(fileName).toBe('WB-2026-000123_Janssens-BV_Onderhoud-Warmtepomp.pdf');
  });

  it('verwijdert accenten en niet-ASCII-tekens', () => {
    const fileName = buildPdfFileName('WB-2026-000001', 'Café François & Zn.', 'Ondérhoud Ç');
    expect(fileName).toBe('WB-2026-000001_Cafe-Francois-Zn_Onderhoud-C.pdf');
  });
});

describe('WorkOrderPdfService.generate()', () => {
  it('genereert de PDF en zet de werkbon op PDF_READY (happy path)', async () => {
    const fakeWorkOrder = createFakeWorkOrder();
    const workOrderService = { get: vi.fn().mockResolvedValue(fakeWorkOrder) };
    const storage = createFakeStorage();
    const companySettings = createFakeCompanySettings();
    const update = vi.fn().mockResolvedValue({});
    const prisma = { workOrder: { update } } as never;

    const service = new WorkOrderPdfService(prisma, storage as never, workOrderService as never, companySettings as never);
    await service.generate('wo-1');

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'wo-1' }, data: { pdfStatus: 'PDF_GENERATING' } });
    const finalCall = update.mock.calls[1]?.[0];
    expect(finalCall.data.pdfStatus).toBe('PDF_READY');
    expect(finalCall.data.pdfFileKey).toBe('pdf-key');
    expect(finalCall.data.pdfFileName).toBe('WB-2026-000123_Janssens-BV_Onderhoud-warmtepomp.pdf');
    expect(finalCall.data.pdfGeneratedAt).toBeInstanceOf(Date);

    expect(storage.save).toHaveBeenCalledTimes(1);
    const [savedBuffer, savedMimeType] = storage.save.mock.calls[0] as [Buffer, string];
    expect(savedMimeType).toBe('application/pdf');
    expect(savedBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('neemt de km-vergoeding mee in de gegenereerde PDF wanneer die van toepassing is (4/9/2026)', async () => {
    const fakeWorkOrder = createFakeWorkOrder({
      kmAmountCents: 8750,
      project: {
        name: 'Onderhoud warmtepomp',
        projectNumber: 'PRO-42',
        address: 'Kerkstraat 1, 9000 Gent',
        kmDistanceOneWayMeters: 12_500,
        customer: { name: 'Janssens BV', address: 'Kerkstraat 1, 9000 Gent', vatNumber: 'BE0123456789' },
      },
    });
    const workOrderService = { get: vi.fn().mockResolvedValue(fakeWorkOrder) };
    const storage = createFakeStorage();
    const companySettings = createFakeCompanySettings();
    const update = vi.fn().mockResolvedValue({});
    const prisma = { workOrder: { update } } as never;

    const service = new WorkOrderPdfService(prisma, storage as never, workOrderService as never, companySettings as never);
    await service.generate('wo-1');

    // Enkel bevestigen dat de PDF-generatie zelf niet faalt met deze extra
    // velden (het effectieve tekstuele resultaat wordt gedetailleerd getest
    // in work-order-pdf-document.test.ts, op de element-boom i.p.v. de PDF-
    // bytes zelf).
    const finalCall = update.mock.calls[1]?.[0];
    expect(finalCall.data.pdfStatus).toBe('PDF_READY');
    const [savedBuffer] = storage.save.mock.calls[0] as [Buffer, string];
    expect(savedBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('gooit notSignedForPdf() voor een DRAFT-werkbon, zonder de werkbon aan te raken', async () => {
    const fakeWorkOrder = createFakeWorkOrder({ status: 'DRAFT', signature: null });
    const workOrderService = { get: vi.fn().mockResolvedValue(fakeWorkOrder) };
    const storage = createFakeStorage();
    const companySettings = createFakeCompanySettings();
    const update = vi.fn();
    const prisma = { workOrder: { update } } as never;

    const service = new WorkOrderPdfService(prisma, storage as never, workOrderService as never, companySettings as never);

    await expect(service.generate('wo-1')).rejects.toBeInstanceOf(ApiError);
    await expect(service.generate('wo-1')).rejects.toMatchObject({ code: 'WORK_ORDER_NOT_SIGNED' });
    expect(update).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('gooit pdfGenerationInProgress() wanneer de PDF al aan het genereren is', async () => {
    const fakeWorkOrder = createFakeWorkOrder({ pdfStatus: 'PDF_GENERATING' });
    const workOrderService = { get: vi.fn().mockResolvedValue(fakeWorkOrder) };
    const storage = createFakeStorage();
    const companySettings = createFakeCompanySettings();
    const update = vi.fn();
    const prisma = { workOrder: { update } } as never;

    const service = new WorkOrderPdfService(prisma, storage as never, workOrderService as never, companySettings as never);

    await expect(service.generate('wo-1')).rejects.toMatchObject({ code: 'WORK_ORDER_PDF_GENERATING' });
    expect(update).not.toHaveBeenCalled();
  });

  it('zet de werkbon op PDF_FAILED met een mensentaal-boodschap, en gooit zelf NIET verder, bij een opslagfout', async () => {
    const fakeWorkOrder = createFakeWorkOrder();
    const workOrderService = { get: vi.fn().mockResolvedValue(fakeWorkOrder) };
    const storage = createFakeStorage({ save: vi.fn().mockRejectedValue(new Error('S3 is even onbereikbaar')) });
    const companySettings = createFakeCompanySettings();
    const update = vi.fn().mockResolvedValue({});
    const prisma = { workOrder: { update } } as never;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const service = new WorkOrderPdfService(prisma, storage as never, workOrderService as never, companySettings as never);
    await expect(service.generate('wo-1')).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(2);
    const finalCall = update.mock.calls[1]?.[0];
    expect(finalCall.data.pdfStatus).toBe('PDF_FAILED');
    expect(finalCall.data.pdfError).toContain('PDF opnieuw genereren');
    expect(finalCall.data.pdfError).not.toContain('S3'); // ruwe fout mag nooit in het klant-zichtbare veld lekken (sectie 27)
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
