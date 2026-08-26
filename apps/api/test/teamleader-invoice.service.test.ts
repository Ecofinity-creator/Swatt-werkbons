import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TeamleaderInvoiceService } from '../src/modules/teamleader/teamleader-invoice.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from '../src/modules/teamleader/teamleader-auth.service';

/**
 * Unit-tests voor "Maak conceptfactuur in Teamleader" (Phase 10b, sectie 17).
 * Fake-Prisma bootst enkel `invoiceBatch.findUnique`/`.update` en
 * `teamleaderConnection.findUnique` na — precies wat deze service gebruikt.
 */

interface FakeConnectionSettings {
  invoiceDepartmentId: string | null;
  invoiceTaxRateId: string | null;
  invoicePaymentTermType: string | null;
  invoicePaymentTermDays: number | null;
}

interface FakeBatch {
  id: string;
  status: string;
  customerId: string;
  customer: { name: string; teamleaderId: string; teamleaderType: string; hourlyRateCents: number | null };
  teamleaderInvoiceId?: string | null;
  teamleaderSyncError?: string | null;
  lines: Array<{
    invoiceableSeconds: number;
    workOrder: {
      workOrderNumber: string;
      description: string | null;
      project: { id: string; name: string; teamleaderId: string };
      timeEntries: Array<{ timeEntry: { employee: { displayName: string } } }>;
    };
  }>;
}

function createFakePrisma(batch: FakeBatch, connectionSettings: FakeConnectionSettings | null) {
  const state = { ...batch };

  const prisma = {
    invoiceBatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === state.id ? { ...state } : null)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeBatch> }) => {
        if (where.id !== state.id) throw new Error('batch niet gevonden');
        Object.assign(state, data);
        return { ...state };
      }),
    },
    teamleaderConnection: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === TEAMLEADER_CONNECTION_SINGLETON_ID ? connectionSettings : null,
      ),
    },
  };

  return { prisma: prisma as unknown as PrismaClient, getState: () => state };
}

function fakeClient(post: (...args: unknown[]) => Promise<unknown>): TeamleaderClient {
  return { post: vi.fn(post), listAll: vi.fn() } as unknown as TeamleaderClient;
}

const validSettings: FakeConnectionSettings = {
  invoiceDepartmentId: 'dep-1',
  invoiceTaxRateId: 'tax-21',
  invoicePaymentTermType: 'CASH',
  invoicePaymentTermDays: 0,
}

const baseLine = {
  invoiceableSeconds: 2 * 60 * 60 + 17 * 60, // 2u17
  workOrder: {
    workOrderNumber: 'WB-2026-000123',
    description: 'Onderhoud uitgevoerd.',
    project: { id: 'proj-1', name: 'Onderhoud HVAC', teamleaderId: 'tl-proj-1' },
    timeEntries: [{ timeEntry: { employee: { displayName: 'Peter Janssens' } } }],
  },
};

function baseBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return {
    id: 'batch-1',
    status: 'DRAFT',
    customerId: 'cust-1',
    customer: { name: 'Janssens BV', teamleaderId: 'tl-cust-1', teamleaderType: 'company', hourlyRateCents: 6500 },
    lines: [baseLine],
    ...overrides,
  };
}

describe('TeamleaderInvoiceService', () => {
  it('maakt een conceptfactuur aan en zet de batch op SUBMITTED_TO_TEAMLEADER', async () => {
    const { prisma, getState } = createFakePrisma(baseBatch(), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    const result = await service.createDraftInvoice('batch-1');

    expect(result).toEqual({ success: true, message: null });
    expect(getState().status).toBe('SUBMITTED_TO_TEAMLEADER');
    expect(getState()).toMatchObject({ teamleaderInvoiceId: 'tl-invoice-1', teamleaderSyncError: null });

    const [endpoint, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(endpoint).toBe('invoices.draft');
    expect(payload.invoicee).toEqual({ customer: { type: 'company', id: 'tl-cust-1' } });
    expect(payload.department_id).toBe('dep-1');
    expect(payload.payment_term).toEqual({ type: 'CASH', days: 0 });
    expect(payload.project_id).toBe('tl-proj-1'); // enkele batchregel ⇒ project_id wordt meegestuurd
    const lineItems = (payload.grouped_lines as Array<{ line_items: Array<Record<string, unknown>> }>)[0]?.line_items;
    expect(lineItems).toHaveLength(1);
    expect(lineItems?.[0]?.quantity).toBeCloseTo(2.28, 2); // 2u17 → 2,28u
    expect(lineItems?.[0]?.unit_price).toEqual({ amount: 65, tax: 'excluding' });
    expect(lineItems?.[0]?.tax_rate_id).toBe('tax-21');
    expect(lineItems?.[0]?.description).toContain('WB-2026-000123');
    expect(lineItems?.[0]?.description).toContain('Peter Janssens');
  });

  it('laat project_id weg wanneer de batch werkbonnen van verschillende projecten bevat', async () => {
    const otherProjectLine = {
      ...baseLine,
      workOrder: { ...baseLine.workOrder, project: { id: 'proj-2', name: 'Interventie', teamleaderId: 'tl-proj-2' } },
    };
    const { prisma } = createFakePrisma(baseBatch({ lines: [baseLine, otherProjectLine] }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await service.createDraftInvoice('batch-1');

    const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.project_id).toBeUndefined();
  });

  it('weigert wanneer de klant nog geen uurtarief heeft', async () => {
    const { prisma } = createFakePrisma(baseBatch({ customer: { name: 'Janssens BV', teamleaderId: 'tl-cust-1', teamleaderType: 'company', hourlyRateCents: null } }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await expect(service.createDraftInvoice('batch-1')).rejects.toMatchObject({ code: 'INVOICE_BATCH_HOURLY_RATE_NOT_SET' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('weigert wanneer de facturatie-instellingen nog niet (volledig) ingesteld zijn', async () => {
    const { prisma } = createFakePrisma(baseBatch(), { ...validSettings, invoiceTaxRateId: null });
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await expect(service.createDraftInvoice('batch-1')).rejects.toMatchObject({ code: 'TEAMLEADER_INVOICE_SETTINGS_NOT_CONFIGURED' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('weigert een batch die al ingediend is', async () => {
    const { prisma } = createFakePrisma(baseBatch({ status: 'SUBMITTED_TO_TEAMLEADER' }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await expect(service.createDraftInvoice('batch-1')).rejects.toMatchObject({ code: 'INVOICE_BATCH_ALREADY_SUBMITTED' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('laat de batch op DRAFT staan met een mensentaal-fout bij een mislukte Teamleader-aanroep (business rule 9)', async () => {
    const { prisma, getState } = createFakePrisma(baseBatch(), validSettings);
    const client = fakeClient(async () => {
      throw new TeamleaderApiError(422, 'invoices.draft', 'invoices.draft gaf 422 terug: tax_rate_id is invalid');
    });
    const service = new TeamleaderInvoiceService(prisma, client);

    const result = await service.createDraftInvoice('batch-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Synchroniseren met Teamleader is mislukt');
    expect(getState().status).toBe('DRAFT'); // nooit gewijzigd bij een mislukte poging
    expect(getState().teamleaderInvoiceId).toBeUndefined();
    expect(getState().teamleaderSyncError).toContain('tax_rate_id is invalid');
  });
});
