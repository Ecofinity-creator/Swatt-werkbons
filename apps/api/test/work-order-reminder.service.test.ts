import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '../src/modules/audit-log/audit-log.service';
import type { EmailService } from '../src/modules/email/email.service';
import { WorkOrderReminderService } from '../src/modules/reminders/work-order-reminder.service';

vi.mock('../src/config/env', () => ({
  isEmailConfigured: vi.fn(() => true),
}));

interface FakeWorkOrder {
  id: string;
  workOrderNumber: string;
  status: string;
  createdAt: Date;
  reminderSentAt: Date | null;
  projectName: string;
  customerName: string;
  employeeDisplayName: string;
  employeeUserId: string;
  employeeEmail: string;
}

function createFakePrisma(workOrders: FakeWorkOrder[]) {
  const prisma = {
    workOrder: {
      findMany: async ({ where }: { where: { status: string; createdAt: { lt: Date }; reminderSentAt: null } }) => {
        return workOrders
          .filter((wo) => wo.status === where.status && wo.createdAt < where.createdAt.lt && wo.reminderSentAt === where.reminderSentAt)
          .map((wo) => ({
            id: wo.id,
            workOrderNumber: wo.workOrderNumber,
            createdAt: wo.createdAt,
            project: { name: wo.projectName, customer: { name: wo.customerName } },
            createdByEmployee: { displayName: wo.employeeDisplayName, user: { id: wo.employeeUserId, email: wo.employeeEmail } },
          }));
      },
      update: async ({ where, data }: { where: { id: string }; data: { reminderSentAt: Date } }) => {
        const wo = workOrders.find((w) => w.id === where.id);
        if (wo) wo.reminderSentAt = data.reminderSentAt;
        return wo;
      },
    },
  };
  return prisma as unknown as PrismaClient;
}

function makeWorkOrder(overrides: Partial<FakeWorkOrder> & { id: string }): FakeWorkOrder {
  return {
    workOrderNumber: `WB-${overrides.id}`,
    status: 'DRAFT',
    createdAt: new Date('2026-08-01T08:00:00Z'),
    reminderSentAt: null,
    projectName: 'Onderhoud HVAC',
    customerName: 'Janssens BV',
    employeeDisplayName: 'Peter Janssens',
    employeeUserId: 'user-1',
    employeeEmail: 'peter@ecofinity.eu',
    ...overrides,
  };
}

describe('WorkOrderReminderService', () => {
  let sentEmails: Array<{ to: string; subject: string; html: string }>;
  let emailService: EmailService;
  let auditLogService: AuditLogService;

  beforeEach(() => {
    sentEmails = [];
    emailService = { send: vi.fn(async (params) => void sentEmails.push(params)) };
    auditLogService = { record: vi.fn(async () => undefined) } as unknown as AuditLogService;
  });

  it('stuurt een herinnering voor een DRAFT-werkbon ouder dan de drempel zonder eerdere herinnering', async () => {
    const oldWorkOrder = makeWorkOrder({ id: 'wo-1', createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) }); // 30u geleden
    const prisma = createFakePrisma([oldWorkOrder]);
    const service = new WorkOrderReminderService(prisma, emailService, auditLogService);

    const sentCount = await service.sendPendingReminders(24);

    expect(sentCount).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('peter@ecofinity.eu');
    expect(sentEmails[0]?.html).toContain('WB-wo-1');
    expect(oldWorkOrder.reminderSentAt).not.toBeNull();
  });

  it('stuurt geen herinnering voor een werkbon die nog niet oud genoeg is', async () => {
    const recentWorkOrder = makeWorkOrder({ id: 'wo-2', createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // 2u geleden
    const prisma = createFakePrisma([recentWorkOrder]);
    const service = new WorkOrderReminderService(prisma, emailService, auditLogService);

    const sentCount = await service.sendPendingReminders(24);

    expect(sentCount).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it('stuurt geen tweede herinnering voor een werkbon die er al één kreeg', async () => {
    const alreadyReminded = makeWorkOrder({
      id: 'wo-3',
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      reminderSentAt: new Date(),
    });
    const prisma = createFakePrisma([alreadyReminded]);
    const service = new WorkOrderReminderService(prisma, emailService, auditLogService);

    const sentCount = await service.sendPendingReminders(24);

    expect(sentCount).toBe(0);
  });

  it('een mislukte verzending blokkeert de andere werkbonnen niet', async () => {
    const willFail = makeWorkOrder({ id: 'wo-4', createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000), employeeEmail: 'fail@ecofinity.eu' });
    const willSucceed = makeWorkOrder({ id: 'wo-5', createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) });
    const prisma = createFakePrisma([willFail, willSucceed]);
    emailService.send = vi.fn(async (params) => {
      if (params.to === 'fail@ecofinity.eu') throw new Error('Resend tijdelijk onbeschikbaar');
      sentEmails.push(params);
    });
    const service = new WorkOrderReminderService(prisma, emailService, auditLogService);

    const sentCount = await service.sendPendingReminders(24);

    expect(sentCount).toBe(1);
    expect(willFail.reminderSentAt).toBeNull(); // blijft null, komt volgende run opnieuw aan bod
    expect(willSucceed.reminderSentAt).not.toBeNull();
  });

  it('doet niets wanneer e-mail niet geconfigureerd is', async () => {
    const { isEmailConfigured } = await import('../src/config/env.js');
    vi.mocked(isEmailConfigured).mockReturnValueOnce(false);
    const oldWorkOrder = makeWorkOrder({ id: 'wo-6', createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
    const prisma = createFakePrisma([oldWorkOrder]);
    const service = new WorkOrderReminderService(prisma, emailService, auditLogService);

    const sentCount = await service.sendPendingReminders(24);

    expect(sentCount).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });
});
