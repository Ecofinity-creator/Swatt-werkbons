import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../src/modules/storage/storage.service';
import { WorkOrderPhotoService } from '../src/modules/work-orders/work-order-photo.service';

/**
 * Unit-tests met een minimale fake-Prisma + fake StorageService (in-memory
 * Map i.p.v. echte opslag) — zelfde patroon als work-order.service.test.ts.
 * Dekt: het toevoegen/verwijderen van foto's, de anti-enumeratie-toegang
 * (enkel deelnemers aan de werkbon), en business rule 3 (een niet-DRAFT
 * werkbon mag niet meer gewijzigd worden).
 */

interface FakeEmployee {
  id: string;
  displayName: string;
}

interface FakeWorkOrder {
  id: string;
  status: string;
  createdByEmployeeId: string;
  timeEntries: Array<{ timeEntryId: string; timeEntry: { employeeId: string } }>;
}

interface FakePhoto {
  id: string;
  workOrderId: string;
  category: string | null;
  description: string | null;
  optimizedFileKey: string;
  thumbnailFileKey: string;
  uploadedByEmployeeId: string;
  createdAt: Date;
}

function createFakePrisma(options: { workOrders?: FakeWorkOrder[]; employees?: FakeEmployee[] } = {}) {
  const workOrders = new Map((options.workOrders ?? []).map((w) => [w.id, w]));
  const employees = new Map((options.employees ?? []).map((e) => [e.id, e]));
  const photos = new Map<string, FakePhoto>();
  let photoIdCounter = 0;

  const workOrder = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => workOrders.get(where.id) ?? null),
  };

  const workOrderPhoto = {
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          workOrderId: string;
          category: string | null;
          description: string | null;
          optimizedFileKey: string;
          thumbnailFileKey: string;
          uploadedByEmployeeId: string;
        };
      }) => {
        const id = `photo-${++photoIdCounter}`;
        const created: FakePhoto = { ...data, id, createdAt: new Date() };
        photos.set(id, created);
        return {
          ...created,
          uploadedByEmployee: { displayName: employees.get(data.uploadedByEmployeeId)?.displayName ?? 'Onbekend' },
        };
      },
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => photos.get(where.id) ?? null),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const existing = photos.get(where.id) ?? null;
      photos.delete(where.id);
      return existing;
    }),
  };

  return { prisma: { workOrder, workOrderPhoto } as unknown as PrismaClient, photos };
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

const EMPLOYEE: FakeEmployee = { id: 'employee-1', displayName: 'Peter' };
const OTHER_EMPLOYEE: FakeEmployee = { id: 'employee-2', displayName: 'Wannes' };

function draftWorkOrder(overrides: Partial<FakeWorkOrder> = {}): FakeWorkOrder {
  return {
    id: 'wo-1',
    status: 'DRAFT',
    createdByEmployeeId: EMPLOYEE.id,
    timeEntries: [{ timeEntryId: 'entry-1', timeEntry: { employeeId: EMPLOYEE.id } }],
    ...overrides,
  };
}

function photoInput() {
  return {
    category: 'UITVOERING' as const,
    description: 'Filters gereinigd',
    optimized: { data: Buffer.from('optimized-bytes'), mimeType: 'image/jpeg' },
    thumbnail: { data: Buffer.from('thumb-bytes'), mimeType: 'image/jpeg' },
  };
}

describe('WorkOrderPhotoService', () => {
  it('add() slaat de foto op via StorageService en koppelt de storage-keys aan de werkbon', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()], employees: [EMPLOYEE] });
    const storage = createFakeStorage();
    const service = new WorkOrderPhotoService(prisma, storage);

    const photo = await service.add(EMPLOYEE.id, 'wo-1', photoInput());

    expect(photo.category).toBe('UITVOERING');
    expect(photo.description).toBe('Filters gereinigd');
    expect(photo.uploadedByEmployee).toEqual({ displayName: 'Peter' });
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(photo.optimizedFileKey).not.toBe(photo.thumbnailFileKey);
  });

  it('add() weigert met WORK_ORDER_NOT_FOUND voor een onbestaande werkbon', async () => {
    const { prisma } = createFakePrisma({ employees: [EMPLOYEE] });
    const service = new WorkOrderPhotoService(prisma, createFakeStorage());

    await expect(service.add(EMPLOYEE.id, 'onbestaand', photoInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_NOT_FOUND',
    });
  });

  it('add() weigert met WORK_ORDER_NOT_FOUND voor een werknemer die geen deelnemer is (anti-enumeratie)', async () => {
    const { prisma } = createFakePrisma({
      workOrders: [draftWorkOrder()],
      employees: [EMPLOYEE, OTHER_EMPLOYEE],
    });
    const service = new WorkOrderPhotoService(prisma, createFakeStorage());

    await expect(service.add(OTHER_EMPLOYEE.id, 'wo-1', photoInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_NOT_FOUND',
    });
  });

  it('add() weigert met WORK_ORDER_ALREADY_SIGNED zodra de werkbon niet meer DRAFT is', async () => {
    const { prisma } = createFakePrisma({
      workOrders: [draftWorkOrder({ status: 'SIGNED' })],
      employees: [EMPLOYEE],
    });
    const service = new WorkOrderPhotoService(prisma, createFakeStorage());

    await expect(service.add(EMPLOYEE.id, 'wo-1', photoInput())).rejects.toMatchObject({
      code: 'WORK_ORDER_ALREADY_SIGNED',
    });
  });

  it('remove() verwijdert de foto-rij en ruimt beide storage-keys op', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()], employees: [EMPLOYEE] });
    const storage = createFakeStorage();
    const service = new WorkOrderPhotoService(prisma, storage);
    const photo = await service.add(EMPLOYEE.id, 'wo-1', photoInput());

    await service.remove(EMPLOYEE.id, 'wo-1', photo.id);

    expect(storage.delete).toHaveBeenCalledWith(photo.optimizedFileKey);
    expect(storage.delete).toHaveBeenCalledWith(photo.thumbnailFileKey);
  });

  it('remove() weigert met WORK_ORDER_PHOTO_NOT_FOUND voor een onbestaande foto', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()], employees: [EMPLOYEE] });
    const service = new WorkOrderPhotoService(prisma, createFakeStorage());

    await expect(service.remove(EMPLOYEE.id, 'wo-1', 'onbestaande-foto')).rejects.toMatchObject({
      code: 'WORK_ORDER_PHOTO_NOT_FOUND',
    });
  });

  it('remove() weigert met WORK_ORDER_ALREADY_SIGNED zodra de werkbon niet meer DRAFT is', async () => {
    const { prisma } = createFakePrisma({ workOrders: [draftWorkOrder()], employees: [EMPLOYEE] });
    const storage = createFakeStorage();
    const service = new WorkOrderPhotoService(prisma, storage);
    const photo = await service.add(EMPLOYEE.id, 'wo-1', photoInput());

    const fakeWorkOrder = (prisma as unknown as { workOrder: { findUnique: ReturnType<typeof vi.fn> } }).workOrder;
    fakeWorkOrder.findUnique = vi.fn(async () => draftWorkOrder({ status: 'SIGNED' }));

    await expect(service.remove(EMPLOYEE.id, 'wo-1', photo.id)).rejects.toMatchObject({
      code: 'WORK_ORDER_ALREADY_SIGNED',
    });
  });
});
