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
 *
 * Klantvraag 10/9/2026: het uurtarief zit nu op `project.hourlyRateCents`
 * i.p.v. `employee.defaultHourlyRateCents`, en de eenmalige batch-override is
 * projectgescopeerd (`invoiceBatchProjectRate` i.p.v. `invoiceBatchEmployeeRate`).
 */

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  status: string;
  projectId: string;
  project: {
    id: string;
    customerId: string;
    name: string;
    projectNumber: string | null;
    invoicingEnabled: boolean;
    hourlyRateCents: number | null;
    customer: { id: string; name: string; hourlyRateCents: number | null };
  };
  signature: { signedAt: Date } | null;
  timeEntries: Array<{
    timeEntry: {
      startedAt: Date;
      endedAt: Date | null;
      pausedSeconds: number;
      employeeId: string;
      employee: { id: string; displayName: string };
    };
  }>;
}

function createFakePrisma(workOrders: FakeWorkOrder[]) {
  const batches = new Map<string, { id: string; customerId: string; periodLabel: string; status: string; totalInvoiceableSeconds: number; createdByUserId: string; createdAt: Date }>();
  const lines = new Map<
    string,
    {
      id: string;
      invoiceBatchId: string;
      workOrderId: string;
      invoiceableSeconds: number;
      /** Klantvraag 10/9/2026 — zie InvoiceBatchService.setLineAdjustment. */
      adjustedInvoiceableSeconds: number | null;
      adjustedKmAmountCents: number | null;
      adjustmentNote: string | null;
    }
  >();
  /** invoiceBatchId → projectId → hourlyRateCents — zie InvoiceBatchProjectRate. */
  const projectRateOverrides = new Map<string, Map<string, number>>();
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
          const projectFilter = where.project as { customerId?: string; invoicingEnabled?: boolean } | undefined;
          if (projectFilter?.customerId && wo.project.customerId !== projectFilter.customerId) return false;
          if (projectFilter?.invoicingEnabled !== undefined && wo.project.invoicingEnabled !== projectFilter.invoicingEnabled) return false;
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
          lines.set(lineId, {
            id: lineId,
            invoiceBatchId: id,
            workOrderId: line.workOrderId,
            invoiceableSeconds: line.invoiceableSeconds,
            adjustedInvoiceableSeconds: null,
            adjustedKmAmountCents: null,
            adjustmentNote: null,
          });
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
    invoiceBatchProjectRate: {
      upsert: async ({ create }: { create: { invoiceBatchId: string; projectId: string; hourlyRateCents: number } }) => {
        if (!projectRateOverrides.has(create.invoiceBatchId)) projectRateOverrides.set(create.invoiceBatchId, new Map());
        projectRateOverrides.get(create.invoiceBatchId)!.set(create.projectId, create.hourlyRateCents);
      },
      deleteMany: async ({ where }: { where: { invoiceBatchId: string; projectId: string } }) => {
        projectRateOverrides.get(where.invoiceBatchId)?.delete(where.projectId);
      },
    },
    /** Klantvraag 10/9/2026 — zie InvoiceBatchService.setLineAdjustment. */
    invoiceBatchLine: {
      findUnique: async ({ where }: { where: { id: string } }) => (lines.has(where.id) ? { ...lines.get(where.id)! } : null),
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ adjustedInvoiceableSeconds: number | null; adjustedKmAmountCents: number | null; adjustmentNote: string | null }> }) => {
        const line = lines.get(where.id);
        if (!line) throw new Error('regel niet gevonden');
        Object.assign(line, data);
        return { ...line };
      },
    },
  };

  function hydrateBatch(id: string) {
    const batch = batches.get(id);
    if (!batch) throw new Error('batch niet gevonden');
    const batchLines = Array.from(lines.values()).filter((line) => line.invoiceBatchId === id);
    const customer = workOrders.find((wo) => wo.project.customerId === batch.customerId)?.project.customer ?? { id: batch.customerId, name: '?', hourlyRateCents: null };
    const overrides = projectRateOverrides.get(id) ?? new Map<string, number>();
    return {
      ...batch,
      customer,
      lines: batchLines.map((line) => {
        const wo = workOrders.find((w) => w.id === line.workOrderId);
        return {
          id: line.id,
          workOrderId: line.workOrderId,
          invoiceableSeconds: line.invoiceableSeconds,
          adjustedInvoiceableSeconds: line.adjustedInvoiceableSeconds,
          adjustedKmAmountCents: line.adjustedKmAmountCents,
          adjustmentNote: line.adjustmentNote,
          workOrder: {
            workOrderNumber: wo?.workOrderNumber ?? '?',
            project: { id: wo?.project.id ?? '?', name: wo?.project.name ?? '?', hourlyRateCents: wo?.project.hourlyRateCents ?? null },
            kmAmountCents: null as number | null,
            signature: wo?.signature ?? null,
            timeEntries: wo?.timeEntries ?? [],
          },
        };
      }),
      projectRates: Array.from(overrides.entries()).map(([projectId, hourlyRateCents]) => ({ projectId, hourlyRateCents })),
    };
  }

  return { prisma: prisma as unknown as PrismaClient };
}

const janssens = { id: 'cust-janssens', name: 'Janssens BV', hourlyRateCents: 6500 };
const deSmet = { id: 'cust-desmet', name: 'De Smet NV', hourlyRateCents: null };
const peter = 'emp-peter';
const wannes = 'emp-wannes';
const proj1 = { id: 'proj-1', name: 'Onderhoud HVAC', hourlyRateCents: 6500 as number | null };
const projZonderTarief = { id: 'proj-2', name: 'Interventie', hourlyRateCents: null as number | null };

function workOrder(overrides: Partial<FakeWorkOrder> & { id: string }): FakeWorkOrder {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    status: 'READY_FOR_INVOICING',
    projectId: proj1.id,
    project: { id: proj1.id, customerId: janssens.id, name: proj1.name, projectNumber: 'PRO-1', invoicingEnabled: true, hourlyRateCents: proj1.hourlyRateCents, customer: janssens },
    signature: { signedAt: new Date('2026-08-10T10:00:00Z') },
    timeEntries: [],
    ...overrides,
  };
}

describe('InvoiceBatchService', () => {
  it('listInvoiceable() toont enkel READY_FOR_INVOICING werkbonnen die nog niet gebatcht zijn, met correct berekende uren', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
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
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
    });
    const wo2 = workOrder({
      id: 'wo2',
      signature: { signedAt: new Date('2026-07-15T10:00:00Z') },
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-07-15T08:00:00Z'), endedAt: new Date('2026-07-15T09:30:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes' } } }],
    });
    const { prisma } = createFakePrisma([wo1, wo2]);
    const service = new InvoiceBatchService(prisma);

    expect((await service.listInvoiceable({ periodLabel: '2026-08' })).map((r) => r.id)).toEqual(['wo1']);
    expect((await service.listInvoiceable({ employeeId: wannes })).map((r) => r.id)).toEqual(['wo2']);
  });

  it('create() maakt een batch aan, telt de uren correct op en maakt de werkbon meteen onbeschikbaar voor een volgende batch', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:17:00Z'), pausedSeconds: 17 * 60, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
    });
    const { prisma } = createFakePrisma([wo1]);
    const service = new InvoiceBatchService(prisma);

    const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });

    expect(batch.totalInvoiceableSeconds).toBe(2 * 60 * 60);
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0]?.workOrder.workOrderNumber).toBe('WB-wo1');
    // Klantvraag 10/9/2026: tarief per project — het project heeft al een standaardtarief, dus meteen "effectief".
    expect(batch.projectRates).toEqual([
      { projectId: proj1.id, projectName: proj1.name, defaultHourlyRateCents: 6500, overrideHourlyRateCents: null, effectiveHourlyRateCents: 6500 },
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

  it('Phase 12, deel C: een werkbon van een nacalculatie-project (invoicingEnabled=false) verschijnt nooit bij listInvoiceable() en kan niet gebatcht worden', async () => {
    const wo1 = workOrder({
      id: 'wo1',
      project: { id: 'proj-nacalc', customerId: janssens.id, name: 'Nacalculatie-project', projectNumber: 'PRO-9', invoicingEnabled: false, hourlyRateCents: 6500, customer: janssens },
      timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
    });
    const { prisma } = createFakePrisma([wo1]);
    const service = new InvoiceBatchService(prisma);

    // Verschijnt niet in het overzicht, ook al staat de werkbon op READY_FOR_INVOICING...
    expect(await service.listInvoiceable()).toHaveLength(0);

    // ...en kan ook niet via een rechtstreeks meegegeven work-order-ID gebatcht worden (backstop, sectie 3).
    await expect(
      service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' }),
    ).rejects.toMatchObject({ code: 'INVOICE_BATCH_WORK_ORDER_NOT_INVOICEABLE' });
  });

  it('create() weigert wanneer een werkbon niet bij de opgegeven klant hoort', async () => {
    const woOther = workOrder({ id: 'wo1', project: { id: 'proj-2', customerId: deSmet.id, name: 'Service', projectNumber: null, invoicingEnabled: true, hourlyRateCents: null, customer: deSmet } });
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
    const wo1 = workOrder({ id: 'wo1', timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T09:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }] });
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

  describe('setProjectRate() — klantvraag 10/9/2026: tarief per project i.p.v. per medewerker', () => {
    it('vult een eenmalige override voor een project zonder standaardtarief', async () => {
      const woZonderTarief = workOrder({
        id: 'wo1',
        project: { id: projZonderTarief.id, customerId: janssens.id, name: projZonderTarief.name, projectNumber: 'PRO-2', invoicingEnabled: true, hourlyRateCents: null, customer: janssens },
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes' } } }],
      });
      const { prisma } = createFakePrisma([woZonderTarief]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      expect(batch.projectRates).toEqual([
        { projectId: projZonderTarief.id, projectName: projZonderTarief.name, defaultHourlyRateCents: null, overrideHourlyRateCents: null, effectiveHourlyRateCents: null },
      ]);

      const updated = await service.setProjectRate(batch.id, projZonderTarief.id, 4800);

      expect(updated.projectRates).toEqual([
        { projectId: projZonderTarief.id, projectName: projZonderTarief.name, defaultHourlyRateCents: null, overrideHourlyRateCents: 4800, effectiveHourlyRateCents: 4800 },
      ]);
    });

    it('wist de override weer bij hourlyRateCents: null', async () => {
      const woZonderTarief = workOrder({
        id: 'wo1',
        project: { id: projZonderTarief.id, customerId: janssens.id, name: projZonderTarief.name, projectNumber: 'PRO-2', invoicingEnabled: true, hourlyRateCents: null, customer: janssens },
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: wannes, employee: { id: wannes, displayName: 'Wannes' } } }],
      });
      const { prisma } = createFakePrisma([woZonderTarief]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      await service.setProjectRate(batch.id, projZonderTarief.id, 4800);

      const updated = await service.setProjectRate(batch.id, projZonderTarief.id, null);

      expect(updated.projectRates[0]).toMatchObject({ overrideHourlyRateCents: null, effectiveHourlyRateCents: null });
    });

    it('weigert een project dat niet op deze batch voorkomt', async () => {
      const wo1 = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
      });
      const { prisma } = createFakePrisma([wo1]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });

      await expect(service.setProjectRate(batch.id, projZonderTarief.id, 4800)).rejects.toMatchObject({ code: 'INVOICE_BATCH_PROJECT_NOT_ON_BATCH' });
    });

    it('weigert op een batch die al naar Teamleader verstuurd is', async () => {
      const wo1 = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:00:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
      });
      const { prisma } = createFakePrisma([wo1]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      await prisma.invoiceBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTED_TO_TEAMLEADER' } });

      await expect(service.setProjectRate(batch.id, proj1.id, 6500)).rejects.toMatchObject({ code: 'INVOICE_BATCH_ALREADY_SUBMITTED' });
    });
  });

  describe('setLineAdjustment() — klantvraag 10/9/2026: uren/km corrigeren vóór "Maak conceptfactuur in Teamleader"', () => {
    async function createBatchWithOneLine() {
      const wo1 = workOrder({
        id: 'wo1',
        timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-10T08:00:00Z'), endedAt: new Date('2026-08-10T10:17:00Z'), pausedSeconds: 0, employeeId: peter, employee: { id: peter, displayName: 'Peter Janssens' } } }],
      });
      const { prisma } = createFakePrisma([wo1]);
      const service = new InvoiceBatchService(prisma);
      const batch = await service.create({ customerId: janssens.id, periodLabel: '2026-08', workOrderIds: ['wo1'], createdByUserId: 'user-admin' });
      return { prisma, service, batch };
    }

    it('vult een correctie op één regel — de werkelijke invoiceableSeconds blijft ongewijzigd, enkel de override wordt gezet', async () => {
      const { service, batch } = await createBatchWithOneLine();
      const line = batch.lines[0]!;

      const updated = await service.setLineAdjustment(batch.id, line.id, {
        adjustedInvoiceableSeconds: 3600,
        adjustedKmAmountCents: 500,
        adjustmentNote: 'Klant akkoord met 1u i.p.v. 2u17',
      });

      const updatedLine = updated.lines[0]!;
      expect(updatedLine.invoiceableSeconds).toBe(2 * 60 * 60 + 17 * 60); // werkelijke waarde onaangeroerd
      expect(updatedLine).toMatchObject({
        adjustedInvoiceableSeconds: 3600,
        adjustedKmAmountCents: 500,
        adjustmentNote: 'Klant akkoord met 1u i.p.v. 2u17',
      });
    });

    it('wist de correctie weer bij null', async () => {
      const { service, batch } = await createBatchWithOneLine();
      const line = batch.lines[0]!;
      await service.setLineAdjustment(batch.id, line.id, { adjustedInvoiceableSeconds: 3600, adjustedKmAmountCents: 500, adjustmentNote: 'test' });

      const updated = await service.setLineAdjustment(batch.id, line.id, { adjustedInvoiceableSeconds: null, adjustedKmAmountCents: null, adjustmentNote: null });

      expect(updated.lines[0]).toMatchObject({ adjustedInvoiceableSeconds: null, adjustedKmAmountCents: null, adjustmentNote: null });
    });

    it('weigert een regel die niet op deze batch voorkomt', async () => {
      const { service, batch } = await createBatchWithOneLine();

      await expect(
        service.setLineAdjustment(batch.id, 'does-not-exist', { adjustedInvoiceableSeconds: 3600, adjustedKmAmountCents: null, adjustmentNote: null }),
      ).rejects.toMatchObject({ code: 'INVOICE_BATCH_LINE_NOT_ON_BATCH' });
    });

    it('weigert op een batch die al naar Teamleader verstuurd is', async () => {
      const { prisma, service, batch } = await createBatchWithOneLine();
      const line = batch.lines[0]!;
      await prisma.invoiceBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTED_TO_TEAMLEADER' } });

      await expect(
        service.setLineAdjustment(batch.id, line.id, { adjustedInvoiceableSeconds: 3600, adjustedKmAmountCents: null, adjustmentNote: null }),
      ).rejects.toMatchObject({ code: 'INVOICE_BATCH_ALREADY_SUBMITTED' });
    });

    it('weigert een onbestaande batch', async () => {
      const { service } = await createBatchWithOneLine();

      await expect(
        service.setLineAdjustment('does-not-exist', 'line-1', { adjustedInvoiceableSeconds: 3600, adjustedKmAmountCents: null, adjustmentNote: null }),
      ).rejects.toMatchObject({ code: 'INVOICE_BATCH_NOT_FOUND' });
    });
  });
});
