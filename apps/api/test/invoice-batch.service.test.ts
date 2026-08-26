import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { InvoiceBatchService } from '../src/modules/invoice-batches/invoice-batch.service';

/**
 * Unit-tests voor het lokale facturatie-overzicht (Phase 10, sectie 17/29) —
 * met een handgeschreven fake-Prisma die enkel de queries nabootst die deze
 * service effectief gebruikt (`workOrder.findMany`, `invoiceBatch.*`).
 * `invoiceBatchLine`/`hasInvoiceBatchLine` wordt afgeleid uit de
 * `batches`-toestand zelf (niet een los, handmatig bij te houden veld) zodat
 * business rule 7 ("een werkbon mag maar één keer gefactureerd worden")
 * realistisch getest wordt: aanmaken van een batch maakt de werkbon meteen
 * onbeschikbaar voor listInvoiceable()/een volgende create().
 */

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  status: string;
  projectId: string;
  project: { id: string; customerId: string; name: string; projectNumber: string | null; customer: { id: string; name: string; hourlyRateCents: number | null } };
  signature: { signedAt: Date } | null;
  timeEntries: Array<{
    timeEntry: {
      startedAt: Date;
      endedAt: Date | null;
      pausedSeconds: number;
      employeeId: string;
      employee: { id: string; displayName: string; defaultHourlyRateCents: number | null };
    };
  }>;
}

function createFakePrisma(workOrders: FakeWorkOrder[]) {
  const batches = new Map<string, { id: string; customerId: string; periodLabel: string; status: string; totalInvoiceableSeconds: number; createdByUserId: string; createdAt: Date }>();
  const lines = new Map<string, { id: string; invoiceBatchId: string; workOrderId: string; invoiceableSeconds: number }>();
  /** invoiceBatchId → employeeId → hourlyRateCents — zie InvoiceBatchEmployeeRate. */
  const employeeRateOverrides = new Map<string, Map<string, number>>();
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  function batchedWorkOrderIds(): Set<string> {
    return new Set(Array.from(lines.values()).map((line) => line.workOrderId));
  }

  const prisma = {
    workOrder: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const batchedIds = batchedWorkOrderIds();
        return workOrders.filter((wo) => {
          if (where.id && typeof where.id === 'object' && 'in' in (where.id as object)) {
            return (where.id as { in: string[] }).in.includes(wo.id);
          }
          if (where.status && wo.status !== where.status) return false;
          if ('invoiceBatchLine' in where && where.invoiceBatchLine === null && batchedIds.has(wo.id)) return false;
          if (where.projectId && wo.projectId !== where.projectId) return false;
          const projectFilter = where.project as { customerId?: string } | undefined;
          if (projectFilter?.customerId && wo.project.customerId !== projectFilter.customerId) return false;
          const timeEntriesFilter = where.timeEntries as { some?: { timeEntry?: { employeeId?: string } } } | undefined;
          const employeeId = timeEntriesFilter?.some?.timeEntry?.employeeId;
          if (employeeId && !wo.timeEntries.some((link) => link.timeEntry.employeeId === employeeId)) return false;
          return true;
        }).map((wo) => ({
          ...wo,
          invoiceBatchLine: batchedIds.has(wo.id) ? { id: 'x' } : null,
        }));
      },
    },
    invoiceBatch: {
      create: async ({ data }: { data: { customerId: string; periodLabel: string; createdByUserId: string; totalInvoiceableSeconds: number; lines: { create: Array<{ workOrderId: string; invoiceableSeconds: number }> } } }) => {
        const id = genId('batch');
        const batch = {
          id,
          customerId: data.customerId,
          periodLabel: data.periodLabel,
          status: 'DRAFT',
          totalInvoiceableSeconds: data.totalInvoiceableSeconds,
          createdByUserId: data.createdByUserId,
          createdAt: new Date(),
          teamleaderInvoiceId: null,
          teamleaderSyncError: null,
          teamleaderSubmittedAt: null,
        };
        batches.set(id, batch);
        for (const line of data.lines.create) {
          const lineId = genId('line');
          lines.set(lineId, { id: lineId, invoiceBatchId: id, workOrderId: line.workOrderId, invoiceableSeconds: line.invoiceableSeconds });
        }
        return hydrateBatch(id);
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        return Array.from(batches.values())
          .filter((batch) => (where.customerId ? batch.customerId === where.customerId : true))
          .filter((batch) => (where.periodLabel ? batch.periodLabel === where.periodLabel : true))
          .map((batch) => hydrateBatch(batch.id));
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        return batches.has(where.id) ? hydrateBatch(where.id) : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const batch = batches.get(where.id);
        if (!batch) throw new Error('batch niet gevonden');
        Object.assign(batch, data);
        return hydrateBatch(where.id);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        batches.delete(where.id);
        for (const [lineId, line] of lines) {
          if (line.invoiceBatchId === where.id) lines.delete(lineId);
        }
      },
    },
    invoiceBatchEmployeeRate: {
      upsert: async ({ create }: { create: { invoiceBatchId: string; employeeId: string; hourlyRateCents: number } }) => {
        if (!employeeRateOverrides.has(create.invoiceBatchId)) employeeRateOverrides.set(create.invoiceBatchId, new Map());
        employeeRateOverrides.get(create.invoiceBatchId)!.set(create.employeeId, create.hourlyRateCents);
      },
      deleteMany: async ({ where }: { where: { invoiceBatchId: string; employeeId: string } }) => {
        employeeRateOverrides.get(where.invoiceBatchId)?.delete(where.employeeId);
      },
    },
  };

  function hydrateBatch(id: string) {
    const batch = batches.get(id);
    if (!batch) throw new Error('batch niet gevonden');
    const batchLines = Array.from(lines.values()).filter((line) => line.invoiceBatchId === id);
    const customer = workOrders.find((wo) => wo.project.customerId === batch.customerId)?.project.customer ?? { id: batch.customerId, name: '?', hourlyRateCents: null };
    const overrides = employeeRateOverrides.get(id) ?? new Map<string, number>();
    return {
      ...batch,
      customer,
      lines: batchLines.map((line) => {
        const wo = workOrders.find((w) => w.id === line.workOrderId);
        return {
          id: line.id,
          workOrderId: line.workOrderId,
          invoiceableSeconds: line.invoiceableSeconds,
          workOrder: {
            workOrderNumber: wo?.workOrderNumber ?? '?',
            project: { name: wo?.project.name ?? '?' },
            timeEntries: wo?.timeEntries ?? [],
          },
        };
      }),
      employeeRates: Array.from(overrides.entries()).map(([employeeId, hourlyRateCents]) => ({ employeeId, hourlyRateCents })),
    };
  }

  return { prisma: prisma as unknown as PrismaClient };
}

const janssens = { id: 'cust-janssens', name: 'Janssens BV', hourlyRateCents: 6500 };
const deSmet = { id: 'cust-desmet', name: 'De Smet NV', hourlyRateCents: null };
const peter = 'emp-peter';
const wannes = 'emp-wannes';

function workOrder(overrides: Partial<FakeWorkOrder> & { id: string }): FakeWorkOrder {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    status: 'READY_FOR_INVOICING',
    projectId: 'proj-1',
    project: { id: 'proj-1', customerId: janssens.id, name: 'Onderhoud HVAC', projectNumber: 'PRO-1', customer: janssens },
    signature: { signedAt: new Date('2026-08-10T10:00:00Z') },
    timeEntries: [],
    ...overrides,
  };
}

describe('InvoiceBatchService', () => {
  it('listInvoiceable() toont enkel READY_FOR_INVOICING werkbonnen die nog niet gebatcht zijn, met correct berekende uren', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500 } } }],
    });
    const wo2Draft = workOrder({ id: 'wo2', status: 'DRAFT' });
    const { prisma } = createFakePrisma([wo1, wo2Draft]);
    const service = new InvoiceBatchService(prisma);

    const result = await service.listInvoiceable();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('wo1');
    expect(result[0]?.invoiceableSeconds).toBe(2 * 60 * 60);
    expect(result[0]?.employeeDisplayNames).toEqual(['Peter Janssens']);
  });

  it('listInvoiceable() filtert op periodLabel (ondertekeningsmaand) en op werknemer', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      signature: { signedAt: new Date('2026-08-10T10:00:00Z') },
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500 } } }],
    });
    const wo2 = workOrder({
      id: 'wo2',
      signature: { signedAt: new Date('2026-07-15T10:00:00Z') },
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-07-15T08:00:00Z'), endedAt: new Date('2026-07-15T09:30:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes', defaultHourlyRateCents: 5500 } } }],
    });
    const { prisma } = createFakePrisma([wo1, wo2]);
    const service = new InvoiceBatchService(prisma);

    expect((await service.listInvoiceable({ periodLabel: '2026-08' })).map((r) => r.id)).toEqual(['wo1']);
    expect((await service.listInvoiceable({ employeeId: wannes })).map((r) => r.id)).toEqual(['wo2']);
  });

  it('create() maakt een batch aan, telt de uren correct op en maakt de werkbon meteen onbeschikbaar voor een volgende batch', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:17:00Z'), pausedSeconds: 17 * 60, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500 } } }],
    });
    const { prisma } = createFakePrisma([wo1]);
    const service = new InvoiceBatchService(prisma);

    const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });

    expect(batch.totalInvoiceableSeconds).toBe(2 * 60 * 60);
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0]?.workOrder.workOrderNumber).toBe('WB-wo1');
    // Facturatie: tarief per medewerker — Peter heeft al een standaardtarief, dus meteen "effectief".
    expect(batch.employeeRates).toEqual([
      { employeeId: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500, overrideHourlyRateCents: null, effectiveHourlyRateCents: 6500 },
    ]);

    // Business rule 7: dezelfde werkbon nu niet meer beschikbaar.
    expect(await service.listInvoiceable()).toHaveLength(0);
    await expect(
      service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' }),
    ).rejects.toMatchObject({ code: 'INVOICE_BATCH_WORK_ORDER_ALREADY_BATCHED' });
  });

  it('create() weigert werkbonnen die niet READY_FOR_INVOICING zijn', async () => {
    const wo1 = workOrder({ id: 'wo1', status: 'DRAFT' });
    const { prisma } = createFakePrisma([wo1]);
    const service = new InvoiceBatchService(prisma);

    await expect(
      service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' }),
    ).rejects.toMatchObject({ code: 'INVOICE_BATCH_WORK_ORDER_NOT_INVOICEABLE' });
  });

  it('create() weigert wanneer een werkbon niet bij de opgegeven klant hoort', async () => {
    const woOther = workOrder({ id: 'wo1', project: { id: 'proj-2', customerId: deSmet.id, name: 'Service', projectNumber: null, customer: deSmet } });
    const { prisma } = createFakePrisma([woOther]);
    const service = new InvoiceBatchService(prisma);

    await expect(
      service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' }),
    ).rejects.toMatchObject({ code: 'INVOICE_BATCH_CUSTOMER_MISMATCH' });
  });

  it('create() weigert een lege selectie', async () => {
    const { prisma } = createFakePrisma([]);
    const service = new InvoiceBatchService(prisma);

    await expect(
      service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: [], createdByUserId: 'user-admin' }),
    ).rejects.toMatchObject({ code: 'INVOICE_BATCH_NO_WORK_ORDERS' });
  });

  it('remove() verwijdert een DRAFT-batch volledig, en geeft de werkbon weer vrij', async () => {
    const wo1 = workOrder({ id: 'wo1', timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T09:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500 } } }] });
    const { prisma } = createFakePrisma([wo1]);
    const service = new InvoiceBatchService(prisma);
    const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });

    expect(await service.listInvoiceable()).toHaveLength(0);
    await service.remove(batch.id);
    expect(await service.listInvoiceable()).toHaveLength(1);
  });

  it('remove() gooit een mensentaal-fout voor een onbestaande batch', async () => {
    const { prisma } = createFakePrisma([]);
    const service = new InvoiceBatchService(prisma);

    await expect(service.remove('does-not-exist')).rejects.toMatchObject({ code: 'INVOICE_BATCH_NOT_FOUND' });
  });

  describe('setEmployeeRate() — tarief per medewerker i.p.v. per klant', () => {
    it('vult een eenmalige override voor een medewerker zonder standaardtarief', async () => {
      const woWannes = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes', defaultHourlyRateCents: null } } }],
      });
      const { prisma } = createFakePrisma([woWannes]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      expect(batch.employeeRates).toEqual([
        { employeeId: wannes, displayName: 'Wannes', defaultHourlyRateCents: null, overrideHourlyRateCents: null, effectiveHourlyRateCents: null },
      ]);

      const updated = await service.setEmployeeRate(batch.id, wannes, 4800);

      expect(updated.employeeRates).toEqual([
        { employeeId: wannes, displayName: 'Wannes', defaultHourlyRateCents: null, overrideHourlyRateCents: 4800, effectiveHourlyRateCents: 4800 },
      ]);
    });

    it('wist de override weer bij hourlyRateCents: null', async () => {
      const woWannes = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes', defaultHourlyRateCents: null } } }],
      });
      const { prisma } = createFakePrisma([woWannes]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      await service.setEmployeeRate(batch.id, wannes, 4800);

      const updated = await service.setEmployeeRate(batch.id, wannes, null);

      expect(updated.employeeRates[0]).toMatchObject({ overrideHourlyRateCents: null, effectiveHourlyRateCents: null });
    });

    it('weigert een medewerker die niet op deze batch voorkomt', async () => {
      const wo1 = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: 6500 } } }],
      });
      const { prisma } = createFakePrisma([wo1]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });

      await expect(service.setEmployeeRate(batch.id, wannes, 4800)).rejects.toMatchObject({ code: 'INVOICE_BATCH_EMPLOYEE_NOT_ON_BATCH' });
    });

    it('weigert op een batch die al naar Teamleader verstuurd is', async () => {
      const wo1 = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens', defaultHourlyRateCents: null } } }],
      });
      const { prisma } = createFakePrisma([wo1]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      await prisma.invoiceBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTED_TO_TEAMLEADER' } });

      await expect(service.setEmployeeRate(batch.id, peter, 6500)).rejects.toMatchObject({ code: 'INVOICE_BATCH_ALREADY_SUBMITTED' });
    });
  });
});
