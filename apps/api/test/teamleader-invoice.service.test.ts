import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TeamleaderInvoiceService } from '../src/modules/teamleader/teamleader-invoice.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';
import { TEAMLEADER_CONNECTION_SINGLETON_ID } from '../src/modules/teamleader/teamleader-auth.service';

/**
 * Unit-tests voor "Maak conceptfactuur in Teamleader" (Phase 10b, sectie 17).
 *
 * Klantvraag 10/9/2026 — twee wijzigingen t.o.v. Phase 10b, beide hier
 * getest: (1) prijzing per PROJECT (`Project.hourlyRateCents` /
 * `InvoiceBatchProjectRate`) i.p.v. per medewerker, en (2) `grouped_lines`
 * bevat nu één groep per (technieker, project, ISO-week), elk met een
 * `section`-hoofding ("Week N - naam"). Fake-Prisma bootst enkel
 * `invoiceBatch.findUnique`/`.update` en `teamleaderConnection.findUnique`
 * na — precies wat deze service gebruikt.
 */

interface FakeConnectionSettings {
  invoiceDepartmentId: string | null;
  invoiceTaxRateId: string | null;
  invoicePaymentTermType: string | null;
  invoicePaymentTermDays: number | null;
}

interface FakeTimeEntry {
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  employee: { id: string; displayName: string };
}

interface FakeProject {
  id: string;
  name: string;
  teamleaderId: string;
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  overtimeWeeklyThresholdHours: number | null;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
  hourlyRateCents: number | null;
}

interface FakeBatch {
  id: string;
  status: string;
  customerId: string;
  customer: { name: string; teamleaderId: string; teamleaderType: string; hourlyRateCents: number | null };
  teamleaderInvoiceId?: string | null;
  teamleaderSyncError?: string | null;
  projectRates: Array<{ projectId: string; hourlyRateCents: number }>;
  lines: Array<{
    invoiceableSeconds: number;
    workOrder: {
      workOrderNumber: string;
      description: string | null;
      kmAmountCents: number | null;
      createdByEmployeeId: string;
      createdByEmployee: { id: string; displayName: string };
      project: FakeProject;
      timeEntries: Array<{ timeEntry: FakeTimeEntry }>;
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

const peter = { id: 'emp-peter', displayName: 'Peter Janssens' };

/** Fase 12-herziening: default toeslagregeling van een project — geen toeslag actief, standaardpercentages. */
const NO_PREMIUM = {
  overtimeApplies: false,
  premiumType: 'NONE' as const,
  overtimeRatePercent: 150,
  shiftWorkRatePercent: 120,
  nightWorkRatePercent: 150,
};

const project1: FakeProject = {
  id: 'proj-1',
  name: 'Onderhoud HVAC',
  teamleaderId: 'tl-proj-1',
  overtimeThresholdType: 'DAILY',
  overtimeWeeklyThresholdHours: null,
  hourlyRateCents: 6500,
  ...NO_PREMIUM,
};

/** 2u17 gewerkt (08:00 → 10:17, geen pauze, donderdag 20/08/2026 = ISO-week 34) — zelfde uren als het oorspronkelijke voorbeeld. */
function peterTimeEntry(overrides: Partial<FakeTimeEntry['employee']> = {}) {
  return {
    timeEntry: {
      startedAt: new Date('2026-08-20T08:00:00Z'),
      endedAt: new Date('2026-08-20T10:17:00Z'),
      pausedSeconds: 0,
      employee: { ...peter, ...overrides },
    },
  };
}

const baseLine = {
  invoiceableSeconds: 2 * 60 * 60 + 17 * 60, // 2u17
  workOrder: {
    workOrderNumber: 'WB-2026-000123',
    description: 'Onderhoud uitgevoerd.',
    kmAmountCents: null as number | null,
    createdByEmployeeId: peter.id,
    createdByEmployee: peter,
    project: project1,
    timeEntries: [peterTimeEntry()],
  },
};

function baseBatch(overrides: Partial<FakeBatch> = {}): FakeBatch {
  return {
    id: 'batch-1',
    status: 'DRAFT',
    customerId: 'cust-1',
    customer: { name: 'Janssens BV', teamleaderId: 'tl-cust-1', teamleaderType: 'company', hourlyRateCents: null },
    projectRates: [],
    lines: [baseLine],
    ...overrides,
  };
}

/** Elke groep in `grouped_lines` draagt nu een `section`-hoofding — dit haalt gewoon alle line_items uit alle groepen samen op, voor tests die niet specifiek de groepering zelf testen. */
function allLineItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const groups = payload.grouped_lines as Array<{ section?: { title: string }; line_items: Array<Record<string, unknown>> }>;
  return groups.flatMap((group) => group.line_items);
}

describe('TeamleaderInvoiceService', () => {
  it('maakt een conceptfactuur aan en zet de batch op SUBMITTED_TO_TEAMLEADER — geprijsd met het standaardtarief van het project', async () => {
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

    const groups = payload.grouped_lines as Array<{ section: { title: string }; line_items: Array<Record<string, unknown>> }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.section).toEqual({ title: 'Week 34 - Peter Janssens' }); // 20/08/2026 = ISO-week 34

    const lineItems = groups[0]?.line_items ?? [];
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]?.quantity).toBeCloseTo(2.28, 2); // 2u17 → 2,28u
    expect(lineItems[0]?.unit_price).toEqual({ amount: 65, tax: 'excluding' }); // Project.hourlyRateCents (6500)
    expect(lineItems[0]?.tax_rate_id).toBe('tax-21');
    expect(lineItems[0]?.description).toContain('WB-2026-000123');
  });

  it('splitst één werkbon in aparte weekgroepen per medewerker, elk geprijsd met hetzelfde projecttarief', async () => {
    const wannes = { id: 'emp-wannes', displayName: 'Wannes Peeters' };
    const multiEmployeeLine = {
      ...baseLine,
      workOrder: {
        ...baseLine.workOrder,
        timeEntries: [
          peterTimeEntry(),
          {
            timeEntry: {
              startedAt: new Date('2026-08-20T08:15:00Z'),
              endedAt: new Date('2026-08-20T16:30:00Z'), // 8u15 gewerkt
              pausedSeconds: 30 * 60,
              employee: wannes,
            },
          },
        ],
      },
    };
    const { prisma } = createFakePrisma(baseBatch({ lines: [multiEmployeeLine] }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await service.createDraftInvoice('batch-1');

    const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    const groups = payload.grouped_lines as Array<{ section: { title: string }; line_items: Array<Record<string, unknown>> }>;
    // Zelfde project, zelfde week, maar twee verschillende technici ⇒ twee aparte hoofdingen.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.section.title).sort()).toEqual(['Week 34 - Peter Janssens', 'Week 34 - Wannes Peeters']);

    const peterGroup = groups.find((g) => g.section.title.includes('Peter'))!;
    const wannesGroup = groups.find((g) => g.section.title.includes('Wannes'))!;
    // Beiden geprijsd met hetzelfde projecttarief (6500) — het is nu de sectiehoofding, niet het tarief, die per technieker verschilt.
    expect(peterGroup.line_items[0]?.unit_price).toEqual({ amount: 65, tax: 'excluding' });
    expect(peterGroup.line_items[0]?.quantity).toBeCloseTo(2.28, 2);
    expect(wannesGroup.line_items[0]?.unit_price).toEqual({ amount: 65, tax: 'excluding' });
    expect(wannesGroup.line_items[0]?.quantity).toBeCloseTo(7.75, 2); // 8u15 - 0u30 pauze = 7u45
  });

  it('gebruikt de eenmalige batch-override wanneer het project geen standaardtarief heeft', async () => {
    const projectZonderTarief = { ...project1, hourlyRateCents: null };
    const line = { ...baseLine, workOrder: { ...baseLine.workOrder, project: projectZonderTarief } };
    const { prisma } = createFakePrisma(
      baseBatch({ lines: [line], projectRates: [{ projectId: project1.id, hourlyRateCents: 4800 }] }),
      validSettings,
    );
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await service.createDraftInvoice('batch-1');

    const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    const lineItems = allLineItems(payload);
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]?.unit_price).toEqual({ amount: 48, tax: 'excluding' }); // override, niet het (ontbrekende) standaardtarief
  });

  it('laat project_id weg wanneer de batch werkbonnen van verschillende projecten bevat', async () => {
    const otherProjectLine = {
      ...baseLine,
      workOrder: { ...baseLine.workOrder, project: { ...project1, id: 'proj-2', name: 'Interventie', teamleaderId: 'tl-proj-2' } },
    };
    const { prisma } = createFakePrisma(baseBatch({ lines: [baseLine, otherProjectLine] }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await service.createDraftInvoice('batch-1');

    const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.project_id).toBeUndefined();
  });

  it('weigert wanneer een project op de batch nog geen uurtarief heeft (noch standaard, noch een eenmalige override)', async () => {
    const projectZonderTarief = { ...project1, id: 'proj-zonder-tarief', name: 'Project Zonder Tarief', hourlyRateCents: null };
    const line = { ...baseLine, workOrder: { ...baseLine.workOrder, project: projectZonderTarief } };
    const { prisma } = createFakePrisma(baseBatch({ lines: [line] }), validSettings);
    const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
    const service = new TeamleaderInvoiceService(prisma, client);

    await expect(service.createDraftInvoice('batch-1')).rejects.toMatchObject({ code: 'INVOICE_BATCH_PROJECT_HOURLY_RATE_NOT_SET' });
    expect(client.post).not.toHaveBeenCalled();
  });

  describe('Phase 12, deel A — overuren-/ploegen-/nachttoeslag', () => {
    it('geen enkele toeslag van toepassing (geen ProjectAssignment): exact hetzelfde resultaat als vóór deel A', async () => {
      const { prisma } = createFakePrisma(baseBatch(), validSettings); // baseLine.workOrder.project = NO_PREMIUM
      const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
      const service = new TeamleaderInvoiceService(prisma, client);

      await service.createDraftInvoice('batch-1');

      const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      const lineItems = allLineItems(payload);
      expect(lineItems).toHaveLength(1); // geen aparte overurenregel
      expect(lineItems[0]?.unit_price).toEqual({ amount: 65, tax: 'excluding' });
      expect(lineItems[0]?.quantity).toBeCloseTo(2.28, 2);
    });

    it('DAILY-drempel: één werkbon van 9u30 op een project met overtimeApplies=true levert twee regels op (8u normaal, 1u30 overuren) binnen dezelfde weekgroep', async () => {
      const project = { ...project1, overtimeApplies: true, premiumType: 'NONE' as const };
      const line = {
        ...baseLine,
        workOrder: {
          ...baseLine.workOrder,
          project,
          timeEntries: [
            {
              timeEntry: {
                startedAt: new Date('2026-08-20T07:00:00Z'),
                endedAt: new Date('2026-08-20T16:30:00Z'), // 9u30
                pausedSeconds: 0,
                employee: peter,
              },
            },
          ],
        },
      };
      const { prisma } = createFakePrisma(baseBatch({ lines: [line] }), validSettings);
      const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
      const service = new TeamleaderInvoiceService(prisma, client);

      await service.createDraftInvoice('batch-1');

      const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      const groups = payload.grouped_lines as Array<{ section: { title: string }; line_items: Array<Record<string, unknown>> }>;
      expect(groups).toHaveLength(1); // zelfde technieker/project/week ⇒ één hoofding
      const lineItems = groups[0]?.line_items ?? [];
      expect(lineItems).toHaveLength(2);

      const normal = lineItems.find((item) => (item.description as string).includes('Werkuren'));
      const overtime = lineItems.find((item) => (item.description as string).includes('Overuren'));
      expect(normal?.quantity).toBeCloseTo(8, 2);
      expect(normal?.unit_price).toEqual({ amount: 65, tax: 'excluding' }); // 100% van 6500
      expect(overtime?.quantity).toBeCloseTo(1.5, 2);
      expect(overtime?.unit_price).toEqual({ amount: 97.5, tax: 'excluding' }); // 150% van 6500
    });

    it('WEEKLY-drempel over meerdere werkbonnen heen: acceptatiecriterium uit het ontwerp — 39u normaal + 3u overuren bij nachtwerk (200%), samengevoegd onder één weekhoofding', async () => {
      // Peter werkt 3 dagen van 14u (42u totaal) op een WEEKLY-project met drempel 39u, plus nachtwerktoeslag.
      const project = {
        ...project1,
        overtimeThresholdType: 'WEEKLY' as const,
        overtimeWeeklyThresholdHours: 39,
        overtimeApplies: true,
        premiumType: 'NIGHT_WORK' as const,
      };
      const dayEntry = (day: string) => ({
        timeEntry: { startedAt: new Date(`2026-08-${day}T06:00:00Z`), endedAt: new Date(`2026-08-${day}T20:00:00Z`), pausedSeconds: 0, employee: peter },
      });
      const lines = [
        { ...baseLine, workOrder: { ...baseLine.workOrder, workOrderNumber: 'WB-1', project, timeEntries: [dayEntry('17')] } }, // maandag
        { ...baseLine, workOrder: { ...baseLine.workOrder, workOrderNumber: 'WB-2', project, timeEntries: [dayEntry('18')] } }, // dinsdag
        { ...baseLine, workOrder: { ...baseLine.workOrder, workOrderNumber: 'WB-3', project, timeEntries: [dayEntry('19')] } }, // woensdag
      ];
      const { prisma } = createFakePrisma(baseBatch({ lines }), validSettings);
      const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
      const service = new TeamleaderInvoiceService(prisma, client);

      await service.createDraftInvoice('batch-1');

      const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      const groups = payload.grouped_lines as Array<{ section: { title: string }; line_items: Array<Record<string, unknown>> }>;
      expect(groups).toHaveLength(1); // 3 werkbonnen, zelfde week/technieker/project ⇒ 1 hoofding
      expect(groups[0]?.section).toEqual({ title: 'Week 34 - Peter Janssens' });
      const lineItems = groups[0]?.line_items ?? [];
      expect(lineItems).toHaveLength(2); // samengevoegd tot 1 normale + 1 overuren-regel

      const normal = lineItems.find((item) => (item.description as string).includes('Werkuren'));
      const overtime = lineItems.find((item) => (item.description as string).includes('Overuren'));
      expect(normal?.quantity).toBeCloseTo(39, 2);
      expect(normal?.unit_price).toEqual({ amount: 97.5, tax: 'excluding' }); // 150% (nachtwerk) van 6500
      expect(overtime?.quantity).toBeCloseTo(3, 2);
      expect(overtime?.unit_price).toEqual({ amount: 130, tax: 'excluding' }); // 200% (nachtwerk+overuren) van 6500
      // Traceerbaarheid: alle drie werkbonnen van de week staan vermeld.
      expect(normal?.description).toContain('WB-1');
      expect(normal?.description).toContain('WB-2');
      expect(normal?.description).toContain('WB-3');
    });
  });

  describe('Phase 12, deel D — km-vergoeding', () => {
    it('voegt een aparte "verplaatsingskosten"-regel toe onder dezelfde weekhoofding, wanneer kmAmountCents bevroren is op de werkbon', async () => {
      const line = { ...baseLine, workOrder: { ...baseLine.workOrder, kmAmountCents: 868 } }; // 12,4km enkel @ €0,35/km, heen-terug (zie distance.service.test.ts)
      const { prisma } = createFakePrisma(baseBatch({ lines: [line] }), validSettings);
      const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
      const service = new TeamleaderInvoiceService(prisma, client);

      await service.createDraftInvoice('batch-1');

      const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      const groups = payload.grouped_lines as Array<{ section: { title: string }; line_items: Array<Record<string, unknown>> }>;
      expect(groups).toHaveLength(1); // zelfde technieker (createdByEmployee) + week ⇒ samengevoegd onder één hoofding
      const lineItems = groups[0]?.line_items ?? [];
      expect(lineItems).toHaveLength(2); // 1 uren-regel + 1 km-regel

      const kmLine = lineItems.find((item) => (item.description as string).toLowerCase().includes('verplaatsingskosten'));
      expect(kmLine?.quantity).toBe(1);
      expect(kmLine?.unit_price).toEqual({ amount: 8.68, tax: 'excluding' });
      expect(kmLine?.description).toContain(baseLine.workOrder.workOrderNumber);
    });

    it('voegt geen km-regel toe wanneer kmAmountCents null is (geen km-vergoeding actief)', async () => {
      const { prisma } = createFakePrisma(baseBatch(), validSettings); // baseLine.workOrder.kmAmountCents = null
      const client = fakeClient(async () => ({ data: { id: 'tl-invoice-1' } }));
      const service = new TeamleaderInvoiceService(prisma, client);

      await service.createDraftInvoice('batch-1');

      const [, payload] = (client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      const lineItems = allLineItems(payload);
      expect(lineItems.some((item) => (item.description as string).toLowerCase().includes('verplaatsingskosten'))).toBe(false);
    });
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
