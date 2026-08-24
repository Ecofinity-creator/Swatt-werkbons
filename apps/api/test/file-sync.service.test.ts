import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { FileSyncService } from '../src/modules/teamleader/file-sync.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import type { StorageService } from '../src/modules/storage/storage.service';

/**
 * Unit-tests voor sectie 13/31 (PDF-upload naar Teamleader) en business rule
 * 6 (hoogstens één actieve Teamleader-file per werkbon). `fetch` wordt hier
 * WEL gemockt (in tegenstelling tot de andere Phase 9-tests) omdat stap 2 van
 * files.upload rechtstreeks `fetch()` aanroept i.p.v. via TeamleaderClient
 * (zie de uitgebreide toelichting bovenaan file-sync.service.ts).
 */

interface FakeWorkOrder {
  id: string;
  pdfStatus: string;
  pdfFileKey: string | null;
  pdfFileName: string | null;
  workOrderNumber: string;
  teamleaderFileId: string | null;
  teamleaderUploadStatus?: string;
  teamleaderUploadedAt?: Date | null;
  teamleaderUploadError?: string | null;
  project: { teamleaderId: string; teamleaderModule: 'LEGACY' | 'PROJECTS_V2' };
}

function createFakePrisma(workOrder: FakeWorkOrder) {
  const row = { ...workOrder };
  const prisma = {
    workOrder: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== row.id) throw new Error('werkbon niet gevonden');
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeWorkOrder> }) => {
        if (where.id !== row.id) throw new Error('werkbon niet gevonden');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, getRow: () => row };
}

function fakeClient(overrides: Partial<{ post: (...a: unknown[]) => Promise<unknown>; listAll: (...a: unknown[]) => Promise<unknown> }> = {}): TeamleaderClient {
  return {
    post: vi.fn(overrides.post ?? (async () => ({ data: { location: 'https://upload.example/loc-1', expires_at: '2026-08-24T12:00:00Z' } }))),
    listAll: vi.fn(overrides.listAll ?? (async () => [])),
  } as unknown as TeamleaderClient;
}

function fakeStorage(): StorageService {
  return {
    save: vi.fn(),
    read: vi.fn(async () => ({ mimeType: 'application/pdf', data: Buffer.from('pdf-bytes') })),
    delete: vi.fn(),
  };
}

describe('FileSyncService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchOk(body: unknown = { data: { id: 'tl-file-1' } }) {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) }));
    vi.stubGlobal('fetch', fetchMock);
  }

  it('gebruikt subjecttype "project" (legacy) i.p.v. "nextgenProject" voor een legacy Teamleader-project', async () => {
    stubFetchOk();
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000123.pdf',
      workOrderNumber: 'WB-2026-000123',
      teamleaderFileId: null,
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient();
    const service = new FileSyncService(prisma, client, fakeStorage());

    const result = await service.uploadPdf('wo1');

    expect(result).toEqual({ success: true, message: null });
    expect(client.post).toHaveBeenCalledWith(
      'files.upload',
      expect.objectContaining({ subject: { type: 'project', id: 'tl-p1' } }),
    );
    expect(getRow().teamleaderUploadStatus).toBe('TEAMLEADER_UPLOADED');
    expect(getRow().teamleaderFileId).toBe('tl-file-1');
  });

  it('gebruikt subjecttype "nextgenProject" voor een Projects V2-project', async () => {
    stubFetchOk();
    const { prisma } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000124.pdf',
      workOrderNumber: 'WB-2026-000124',
      teamleaderFileId: null,
      project: { teamleaderId: 'tl-p2', teamleaderModule: 'PROJECTS_V2' },
    });
    const client = fakeClient();
    const service = new FileSyncService(prisma, client, fakeStorage());

    await service.uploadPdf('wo1');

    expect(client.post).toHaveBeenCalledWith(
      'files.upload',
      expect.objectContaining({ subject: { type: 'nextgenProject', id: 'tl-p2' } }),
    );
  });

  it('faalt netjes (geen crash) wanneer de PDF nog niet klaar is', async () => {
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_GENERATING',
      pdfFileKey: null,
      pdfFileName: null,
      workOrderNumber: 'WB-2026-000125',
      teamleaderFileId: null,
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient();
    const service = new FileSyncService(prisma, client, fakeStorage());

    const result = await service.uploadPdf('wo1');

    expect(result.success).toBe(false);
    expect(getRow().teamleaderUploadStatus).toBe('TEAMLEADER_UPLOAD_FAILED');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('business rule 6: verwijdert (best-effort) het vorige Teamleader-bestand na een succesvolle reupload', async () => {
    stubFetchOk({ data: { id: 'tl-file-nieuw' } });
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000123.pdf',
      workOrderNumber: 'WB-2026-000123',
      teamleaderFileId: 'tl-file-oud',
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient();
    const service = new FileSyncService(prisma, client, fakeStorage());

    await service.uploadPdf('wo1');

    expect(client.post).toHaveBeenCalledWith('files.delete', { id: 'tl-file-oud' });
    expect(getRow().teamleaderFileId).toBe('tl-file-nieuw');
  });

  it('laat een mislukte verwijdering van het vorige bestand de nieuwe upload niet blokkeren', async () => {
    stubFetchOk({ data: { id: 'tl-file-nieuw' } });
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000123.pdf',
      workOrderNumber: 'WB-2026-000123',
      teamleaderFileId: 'tl-file-oud',
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient({
      post: async (endpoint: unknown) => {
        if (endpoint === 'files.delete') throw new TeamleaderApiError(404, 'files.delete', 'niet gevonden');
        return { data: { location: 'https://upload.example/loc-1', expires_at: '2026-08-24T12:00:00Z' } };
      },
    });
    const service = new FileSyncService(prisma, client, fakeStorage());

    const result = await service.uploadPdf('wo1');

    expect(result).toEqual({ success: true, message: null });
    expect(getRow().teamleaderUploadStatus).toBe('TEAMLEADER_UPLOADED');
  });

  it('valt terug op files.list wanneer stap 2 (bestandsbytes posten) geen bruikbaar file-ID teruggeeft', async () => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '{}' })); // geen data.id in de respons
    vi.stubGlobal('fetch', fetchMock);
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000123.pdf',
      workOrderNumber: 'WB-2026-000123',
      teamleaderFileId: null,
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient({
      listAll: async () => [
        { id: 'tl-gevonden-oud', name: 'WB-2026-000123.pdf', updated_at: '2026-08-20T10:00:00Z' },
        { id: 'tl-gevonden-nieuw', name: 'WB-2026-000123.pdf', updated_at: '2026-08-24T10:00:00Z' },
      ],
    });
    const service = new FileSyncService(prisma, client, fakeStorage());

    const result = await service.uploadPdf('wo1');

    expect(result.success).toBe(true);
    expect(getRow().teamleaderFileId).toBe('tl-gevonden-nieuw'); // meest recente van de gelijknamige bestanden
  });

  it('markeert de upload als mislukt met een mensentaal-boodschap wanneer stap 2 een foutstatus teruggeeft', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'server error' }));
    vi.stubGlobal('fetch', fetchMock);
    const { prisma, getRow } = createFakePrisma({
      id: 'wo1',
      pdfStatus: 'PDF_READY',
      pdfFileKey: 'file-key-1',
      pdfFileName: 'WB-2026-000123.pdf',
      workOrderNumber: 'WB-2026-000123',
      teamleaderFileId: null,
      project: { teamleaderId: 'tl-p1', teamleaderModule: 'LEGACY' },
    });
    const client = fakeClient();
    const service = new FileSyncService(prisma, client, fakeStorage());

    const result = await service.uploadPdf('wo1');

    expect(result.success).toBe(false);
    expect(getRow().teamleaderUploadStatus).toBe('TEAMLEADER_UPLOAD_FAILED');
    expect(getRow().teamleaderUploadError).toBeTruthy();
  });
});
