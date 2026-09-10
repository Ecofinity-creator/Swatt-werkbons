import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../src/modules/storage/storage.service';
import { WorkOrderSignatureService } from '../src/modules/work-orders/work-order-signature.service';

/**
 * Unit-tests met een minimale fake-Prisma + fake StorageService — zelfde
 * patroon als work-order-photo.service.test.ts. Dekt: de overgang
 * DRAFT → SIGNED, dezelfde anti-enumeratie-/immutability-checks als de
 * foto-service, en de P2002-racevertaling naar WORK_ORDER_ALREADY_SIGNED.
 * De reeks Postgres-constraints zelf (unieke `work_order_id` op
 * work_order_signature) is al rechtstreeks tegen een lokale database
 * geverifieerd bij het schrijven van de migratie.
 */

interface FakeEmployee {
  id: string;
}

interface FakeWorkOrder {
  id: string;
  status: string;
  createdByEmployeeId: string;
  description: string | null;
  timeEntries: Array<{ timeEntryId: string; timeEntry: { employeeId: string } }>;
  photos: Array<{ id: string }>;
  /**
   * Klantvraag 10/9/2026 — per-project prijsinstellingen i.p.v. het vroegere
   * bedrijfsbrede CompanySettings.kmRateCents. Default: km-vergoeding niet
   * actief (kmFlatFeeCents: null), drempel/tarief op de projectdefaults.
   */
  project: {
    kmDistanceOneWayMeters: number | null;
    kmFlatFeeThresholdKm: number;
    kmFlatFeeCents: number | null;
    kmRateAboveCentsPerKm: number;
  };
}

function createFakePrisma(options: { workOrders?: FakeWorkOrder[] } = {}) {
  const workOrders = new Map((options.workOrders ?? []).map((w) => [w.id, w]));
  const signaturesByWorkOrder = new Map<string, unknown>();
  let signatureIdCounter = 0;

  const workOrder = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => workOrders.get(where.id) ?? null),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string; kmAmountCents?: number | null; kmDistanceOneWayMeters?: number | null };
      }) => {
        const existing = workOrders.get(where.id);
        if (existing) {
          existing.status = data.status;
          Object.assign(existing, { kmAmountCents: data.kmAmountCents, kmDistanceOneWayMeters: data.kmDistanceOneWayMeters });
        }
        return existing ?? null;
      },
    ),
  };

  const workOrderSignature = {
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          workOrderId: string;
          signerName: string;
          signerFunction: string | null;
          signatureFileKey: string;
          signedAt: Date;
          ipAddress: string | null;
          contentHash: string;
          requestedByUserId: string;
        };
      }) => {
        if (signaturesByWorkOrder.has(data.workOrderId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: Prisma.prismaVersion.client,
          });
        }
        const created = { ...data, id: `sig-${++signatureIdCounter}` };
        signaturesByWorkOrder.set(data.workOrderId, created);
        return created;
      },
    ),
  };

  return {
    prisma: {
      workOrder,
      workOrderSignature,
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaClient,
    workOrders,
  };
}

function createFakeStorage(): StorageService {
  const saved = new Map<string, { data: Buffer; mimeType: string }>();
  let keyCounter = 0;
  return {
    save: vi.fn(async (data: Buffer, mimeType: string) => {
      const key = `stored-${++keyCounter}`;
      saved.set(key, { data, mimeType });
      return key;
    }),
    read: vi.fn(async (key: string) => {
      const found = saved.get(key);
      if (!found) {
        throw new Error(`Onbekende storage-key: ${key}`);
      }
      return found;
    }),
    delete: vi.fn(async (key: string) => {
      saved.delete(key);
    }),
  };
}

const EMPLOYEE: FakeEmployee = { id: 'employee-1' };
const OTHER_EMPLOYEE: FakeEmployee = { id: 'employee-2' };
const REQUESTED_BY_USER_ID = 'user-1';

function draftWorkOrder(overrides: Partial<FakeWorkOrder> = {}): FakeWorkOrder {
  return {
    id: 'wo-1',
    status: 'DRAFT',
    createdByEmployeeId: EMPLOYEE.id,
    description: 'Onderhoud uitgevoerd.',
    timeEntries: [{ timeEntryId: 'entry-1', timeEntry: { employeeId: EMPLOYEE.id } }],
    photos: [{ id: 'photo-1' }],
    project: { kmDistanceOneWayMeters: null, kmFlatFeeThresholdKm: 65, kmFlatFeeCents: null, kmRateAboveCentsPerKm: 80 },
    ...overrides,
  };
}

function signInput(overrides: Partial<{ kmDistanceOneWayMetersOverride: number | null }> = {}) {
  return {
    signerName: 'Jan Janssens',
    signerFunction: 'Zaakvoerder',
    requestedByUserId: REQUESTED_BY_USER_ID,
    ipAddress: '203.0.113.5',
    image: { data: Buffer.from('signature-png-bytes'), mimeType: 'image/png' },
    ...overrides,
  };
}

describe('WorkOrderSignatureService', () => {
  it('sign() maakt de handtekening aan en zet de werkbon op SIGNED', async () => {
    const { prisma, workOrders } = createFakePrisma({ workOrders: [draftWorkOrder()] });
    const storage = createFakeStorage();
    const service = new WorkOrderSignatureService(prisma, storage);

    const signature = await service.sign(EMPLOYEE.id, 'wo-1', signInput());

    expect(signature.signerName).toBe('Jan Janssens');
    expect(signature.signerFunction).toBe('Zaakvoerder');
    expect(signature.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(workOrders.get('wo-1')?.status).toBe('SIGNED');
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('sign() berekent dezelfde contentHash voor eenzelfde werkbon-inhoud, ongeacht tijdstip', async () => {
    const { prisma: prismaA } = createFakePrisma({ workOrders: [draftWorkOrder({ id: 'wo-a' })] });
    const { prisma: prismaB } = createFakePrisma({ workOrders: [draftWorkOrder({ id: 'wo-b' })] });
    const serviceA = new WorkOrderSignatureService(prismaA, createFakeStorage());
    const serviceB = new WorkOrderSignatureService(prismaB, createFakeStorage());

    const sigA = await serviceA.sign(EMPLOYEE.id, 'wo-a', signInput());
    const sigB = await serviceB.sign(EMPLOYEE.id, 'wo-b', signInput());

    expect(sigA.contentHash).toBe(sigB.contentHash);
  });

  it('sign() weigert met WORK_ORDER_NOT_FOUND voor een onbestaande werkbon', async () => {
    const { prisma } = createFakePrisma();
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await expect(service.sign(EMPLOYEE.id, 'onbestaand', signInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_NOT_FOUND',
    });
  });

  it('sign() weigert met WORK_ORDER_NOT_FOUND voor een werknemer die geen deelnemer is (anti-enumeratie)', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()] });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await expect(service.sign(OTHER_EMPLOYEE.id, 'wo-1', signInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_NOT_FOUND',
    });
  });

  it('sign() weigert met WORK_ORDER_ALREADY_SIGNED zodra de werkbon al niet meer DRAFT is', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder({ status: 'SIGNED' })] });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await expect(service.sign(EMPLOYEE.id, 'wo-1', signInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_ALREADY_SIGNED',
    });
  });

  it('sign() vertaalt een unique-constraint-fout (P2002) naar WORK_ORDER_ALREADY_SIGNED', async () => {
    // Simuleert de race condition tussen twee gelijktijdige ondertekenpogingen
    // op dezelfde werkbon: de statuscheck vond op dat moment nog DRAFT, maar
    // de create() zelf botst alsnog op de unieke `work_order_id`-index.
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()] });
    const fakeSignature = (prisma as unknown as { workOrderSignature: { create: ReturnType<typeof vi.fn> } })
      .workOrderSignature;
    fakeSignature.create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      });
    });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await expect(service.sign(EMPLOYEE.id, 'wo-1', signInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_ALREADY_SIGNED',
    });
  });

  // Klantvraag 10/9/2026 — getrapte km-prijs per project + manuele correctie
  // door de werknemer. De formule zelf (computeKmAmountCents) heeft haar
  // eigen, uitgebreidere tests in distance.service.test.ts — hier enkel de
  // integratie: bevriest sign() effectief het juiste bedrag én de juiste
  // afstand op de werkbon, met de override die voorrang krijgt op de
  // automatische projectafstand?
  it('sign() bevriest kmAmountCents en kmDistanceOneWayMeters op basis van de automatische projectafstand wanneer er geen correctie is', async () => {
    const { prisma, workOrders } = createFakePrisma({
      workOrders: [
        draftWorkOrder({
          project: { kmDistanceOneWayMeters: 40_000, kmFlatFeeThresholdKm: 65, kmFlatFeeCents: 3500, kmRateAboveCentsPerKm: 80 },
        }),
      ],
    });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await service.sign(EMPLOYEE.id, 'wo-1', signInput());

    // 40km enkel = 80km heen-terug > drempel 65km → 3500 + 15 * 80 = 4700 cent.
    expect(workOrders.get('wo-1')).toMatchObject({ kmAmountCents: 4700, kmDistanceOneWayMeters: 40_000 });
  });

  it('sign() gebruikt de manuele correctie i.p.v. de automatische projectafstand wanneer opgegeven', async () => {
    const { prisma, workOrders } = createFakePrisma({
      workOrders: [
        draftWorkOrder({
          project: { kmDistanceOneWayMeters: 5_000, kmFlatFeeThresholdKm: 65, kmFlatFeeCents: 3500, kmRateAboveCentsPerKm: 80 },
        }),
      ],
    });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    // Medewerker vertrok deze keer van thuis: 50km enkel i.p.v. de automatisch berekende 5km.
    await service.sign(EMPLOYEE.id, 'wo-1', signInput({ kmDistanceOneWayMetersOverride: 50_000 }));

    // 50km enkel = 100km heen-terug > drempel 65km → 3500 + 35 * 80 = 6300 cent.
    expect(workOrders.get('wo-1')).toMatchObject({ kmAmountCents: 6300, kmDistanceOneWayMeters: 50_000 });
  });

  it('sign() laat kmAmountCents leeg wanneer de km-vergoeding niet actief is voor dit project (kmFlatFeeCents null), ondanks een gekende afstand', async () => {
    const { prisma, workOrders } = createFakePrisma({
      workOrders: [
        draftWorkOrder({
          project: { kmDistanceOneWayMeters: 40_000, kmFlatFeeThresholdKm: 65, kmFlatFeeCents: null, kmRateAboveCentsPerKm: 80 },
        }),
      ],
    });
    const service = new WorkOrderSignatureService(prisma, createFakeStorage());

    await service.sign(EMPLOYEE.id, 'wo-1', signInput());

    expect(workOrders.get('wo-1')).toMatchObject({ kmAmountCents: null, kmDistanceOneWayMeters: 40_000 });
  });
});
