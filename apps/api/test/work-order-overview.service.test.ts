import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { WorkOrderService } from '../src/modules/work-orders/work-order.service';

interface FakeRow {
  id: string;
  workOrderNumber: string;
  status: 'DRAFT' | 'READY_FOR_SIGNATURE' | 'SIGNED' | 'SYNC_PENDING' | 'SYNC_FAILED' | 'READY_FOR_INVOICING' | 'INVOICED';
  createdAt: Date;
  projectId: string;
  teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_PENDING' | 'TEAMLEADER_UPLOADED' | 'TEAMLEADER_UPLOAD_FAILED';
  createdByEmployeeId: string;
  participantEmployeeIds: string[];
  projectName: string;
  customerName: string;
  signedAt: Date | null;
}

function row(overrides: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    status: 'DRAFT',
    createdAt: new Date('2026-08-15T08:00:00Z'),
    projectId: 'project-1',
    teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_PENDING',
    createdByEmployeeId: 'emp-1',
    participantEmployeeIds: [],
    projectName: 'Onderhoud HVAC',
    customerName: 'Janssens BV',
    signedAt: null,
    ...overrides,
  };
}

function createFakePrisma(rows: FakeRow[]) {
  const prisma = {
    workOrder: {
      findMany: async ({
        where,
      }: {
        where: {
          status?: FakeRow['status'];
          projectId?: string;
          OR?: Array<{ createdByEmployeeId?: string; timeEntries?: { some: { timeEntry: { employeeId: string } } } }>;
          NOT?: { status: string };
          teamleaderUploadStatus?: FakeRow['teamleaderUploadStatus'];
          createdAt?: { gte?: Date; lte?: Date };
        };
      }) => {
        let result = [...rows];
        if (where.status) result = result.filter((r) => r.status === where.status);
        if (where.projectId) result = result.filter((r) => r.projectId === where.projectId);
        if (where.NOT?.status) result = result.filter((r) => r.status !== where.NOT!.status);
        if (where.teamleaderUploadStatus) result = result.filter((r) => r.teamleaderUploadStatus === where.teamleaderUploadStatus);
        if (where.createdAt?.gte) result = result.filter((r) => r.createdAt >= where.createdAt!.gte!);
        if (where.createdAt?.lte) result = result.filter((r) => r.createdAt <= where.createdAt!.lte!);
        if (where.OR) {
          const employeeIdClause = where.OR.find((c) => 'createdByEmployeeId' in c)?.createdByEmployeeId;
          const timeEntryClause = where.OR.find((c) => 'timeEntries' in c)?.timeEntries?.some.timeEntry.employeeId;
          const employeeId = employeeIdClause ?? timeEntryClause;
          result = result.filter((r) => r.createdByEmployeeId === employeeId || r.participantEmployeeIds.includes(employeeId!));
        }
        return result
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => ({
            id: r.id,
            workOrderNumber: r.workOrderNumber,
            status: r.status,
            createdAt: r.createdAt,
            projectId: r.projectId,
            teamleaderUploadStatus: r.teamleaderUploadStatus,
            project: { name: r.projectName, projectNumber: 'P-1', customer: { name: r.customerName } },
            createdByEmployee: { displayName: `Medewerker ${r.createdByEmployeeId}` },
            signature: r.signedAt ? { signedAt: r.signedAt } : null,
            timeEntries: [{ timeEntry: { startedAt: new Date('2026-08-15T08:00:00Z'), endedAt: new Date('2026-08-15T10:00:00Z'), pausedSeconds: 0 } }],
          }));
      },
    },
  };
  return prisma as unknown as PrismaClient;
}

describe('WorkOrderService.listForAdmin() — sectie 20: "Werkbonnenoverzicht"', () => {
  it('toont alle werkbonnen zonder filters, meest recente eerst', async () => {
    const prisma = createFakePrisma([
      row({ id: 'wo-1', createdAt: new Date('2026-08-10T08:00:00Z') }),
      row({ id: 'wo-2', createdAt: new Date('2026-08-12T08:00:00Z') }),
    ]);
    const service = new WorkOrderService(prisma);

    const results = await service.listForAdmin({});

    expect(results.map((r) => r.id)).toEqual(['wo-2', 'wo-1']);
  });

  it('filtert op status', async () => {
    const prisma = createFakePrisma([row({ id: 'wo-1', status: 'DRAFT' }), row({ id: 'wo-2', status: 'SIGNED' })]);
    const service = new WorkOrderService(prisma);

    const results = await service.listForAdmin({ status: 'SIGNED' });

    expect(results.map((r) => r.id)).toEqual(['wo-2']);
  });

  it('filtert op "ondertekend" (signed: true/false)', async () => {
    const prisma = createFakePrisma([
      row({ id: 'wo-draft', status: 'DRAFT' }),
      row({ id: 'wo-signed', status: 'SIGNED', signedAt: new Date() }),
    ]);
    const service = new WorkOrderService(prisma);

    expect((await service.listForAdmin({ signed: true })).map((r) => r.id)).toEqual(['wo-signed']);
    expect((await service.listForAdmin({ signed: false })).map((r) => r.id)).toEqual(['wo-draft']);
  });

  it('filtert op project en op Teamleader-syncstatus', async () => {
    const prisma = createFakePrisma([
      row({ id: 'wo-1', projectId: 'project-1', teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_FAILED' }),
      row({ id: 'wo-2', projectId: 'project-2', teamleaderUploadStatus: 'TEAMLEADER_UPLOADED' }),
    ]);
    const service = new WorkOrderService(prisma);

    expect((await service.listForAdmin({ projectId: 'project-2' })).map((r) => r.id)).toEqual(['wo-2']);
    expect((await service.listForAdmin({ teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_FAILED' })).map((r) => r.id)).toEqual(['wo-1']);
  });

  it('mapt alle velden correct (project, klant, medewerker, uren, ondertekeningsdatum)', async () => {
    const prisma = createFakePrisma([
      row({
        id: 'wo-1',
        projectName: 'Interventie CV-ketel',
        customerName: 'De Smet NV',
        createdByEmployeeId: 'emp-peter',
        signedAt: new Date('2026-08-15T16:00:00Z'),
      }),
    ]);
    const service = new WorkOrderService(prisma);

    const [result] = await service.listForAdmin({});

    expect(result).toMatchObject({
      projectName: 'Interventie CV-ketel',
      customerName: 'De Smet NV',
      createdByEmployeeDisplayName: 'Medewerker emp-peter',
      totalSeconds: 7200,
      signedAt: new Date('2026-08-15T16:00:00Z'),
    });
  });
});

describe('WorkOrderService.listForEmployee() — Fase 11: "Mijn werkbonnen"', () => {
  it('toont de volledige geschiedenis van de medewerker (alle statussen), niet enkel DRAFT', async () => {
    const prisma = createFakePrisma([
      row({ id: 'wo-1', createdByEmployeeId: 'emp-1', status: 'DRAFT' }),
      row({ id: 'wo-2', createdByEmployeeId: 'emp-1', status: 'INVOICED', createdAt: new Date('2026-07-01T08:00:00Z') }),
      row({ id: 'wo-3', createdByEmployeeId: 'emp-2', status: 'DRAFT' }), // andere medewerker
    ]);
    const service = new WorkOrderService(prisma);

    const results = await service.listForEmployee('emp-1');

    expect(results.map((r) => r.id).sort()).toEqual(['wo-1', 'wo-2']);
  });

  it('toont een werkbon ook via participatie (tijdregistratie), niet enkel via het aanmaken ervan', async () => {
    const prisma = createFakePrisma([row({ id: 'wo-1', createdByEmployeeId: 'emp-collega', participantEmployeeIds: ['emp-1'] })]);
    const service = new WorkOrderService(prisma);

    const results = await service.listForEmployee('emp-1');

    expect(results.map((r) => r.id)).toEqual(['wo-1']);
  });
});
