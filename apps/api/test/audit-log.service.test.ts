import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '../src/modules/audit-log/audit-log.service';

function createFakePrisma() {
  const rows: Array<{
    id: string;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }> = [];
  let idCounter = 0;

  const prisma = {
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorUserId: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> } }) => {
        const row = { id: `log-${++idCounter}`, metadata: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { entityType?: string; actorUserId?: string; createdAt?: { gte?: Date; lte?: Date } };
          take: number;
        }) => {
          return rows
            .filter((row) => (where.entityType ? row.entityType === where.entityType : true))
            .filter((row) => (where.actorUserId ? row.actorUserId === where.actorUserId : true))
            .filter((row) => (where.createdAt?.gte ? row.createdAt >= where.createdAt.gte : true))
            .filter((row) => (where.createdAt?.lte ? row.createdAt <= where.createdAt.lte : true))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take)
            .map((row) => ({ ...row, actorUser: row.actorUserId ? { email: 'admin@ecofinity.eu', employee: null } : null }));
        },
      ),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

describe('AuditLogService', () => {
  it('record() slaat een audit-rij op met alle velden', async () => {
    const { prisma, rows } = createFakePrisma();
    const service = new AuditLogService(prisma);

    await service.record({
      actorUserId: 'user-1',
      action: 'WORK_ORDER_SIGNED',
      entityType: 'WorkOrder',
      entityId: 'wo-1',
      metadata: { signerName: 'Jan Janssens' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'WORK_ORDER_SIGNED', entityType: 'WorkOrder', entityId: 'wo-1' });
  });

  it('record() gooit nooit door, zelfs als de databankschrijving mislukt (mag de hoofdactie niet blokkeren)', async () => {
    const { prisma } = createFakePrisma();
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB weg'));
    const service = new AuditLogService(prisma);

    await expect(
      service.record({ actorUserId: 'user-1', action: 'X', entityType: 'Y', entityId: 'z' }),
    ).resolves.toBeUndefined();
  });

  it('list() filtert correct op entityType en actorUserId', async () => {
    const { prisma } = createFakePrisma();
    const service = new AuditLogService(prisma);
    await service.record({ actorUserId: 'user-1', action: 'A', entityType: 'WorkOrder', entityId: '1' });
    await service.record({ actorUserId: 'user-2', action: 'B', entityType: 'PayrollBatch', entityId: '2' });

    const workOrderLogs = await service.list({ entityType: 'WorkOrder' });
    expect(workOrderLogs).toHaveLength(1);
    expect(workOrderLogs[0]?.action).toBe('A');

    const user2Logs = await service.list({ actorUserId: 'user-2' });
    expect(user2Logs).toHaveLength(1);
    expect(user2Logs[0]?.action).toBe('B');
  });

  it('list() geeft de meest recente eerst', async () => {
    const { prisma } = createFakePrisma();
    const service = new AuditLogService(prisma);
    await service.record({ actorUserId: 'user-1', action: 'EERST', entityType: 'X', entityId: '1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.record({ actorUserId: 'user-1', action: 'LAATST', entityType: 'X', entityId: '2' });

    const logs = await service.list();
    expect(logs[0]?.action).toBe('LAATST');
    expect(logs[1]?.action).toBe('EERST');
  });
});
