import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { CustomerService } from '../src/modules/customers/customer.service';

/** Phase 10b — uurtarief per klant (zie claude/phase10-facturatie-onderzoek.md: "tarief per klant"). */
function createFakePrisma(customers: Array<{ id: string; name: string; hourlyRateCents: number | null }>) {
  const prisma = {
    customer: {
      findUnique: async ({ where }: { where: { id: string } }) => customers.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { hourlyRateCents: number | null } }) => {
        const customer = customers.find((c) => c.id === where.id);
        if (!customer) throw new Error('niet gevonden');
        customer.hourlyRateCents = data.hourlyRateCents;
        return { id: customer.id, name: customer.name, hourlyRateCents: customer.hourlyRateCents };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient };
}

describe('CustomerService', () => {
  it('updateHourlyRate() zet het tarief van een klant', async () => {
    const { prisma } = createFakePrisma([{ id: 'cust-1', name: 'Janssens BV', hourlyRateCents: null }]);
    const service = new CustomerService(prisma);

    const result = await service.updateHourlyRate('cust-1', 6500);

    expect(result.hourlyRateCents).toBe(6500);
  });

  it('updateHourlyRate() met null wist een eerder ingesteld tarief', async () => {
    const { prisma } = createFakePrisma([{ id: 'cust-1', name: 'Janssens BV', hourlyRateCents: 6500 }]);
    const service = new CustomerService(prisma);

    const result = await service.updateHourlyRate('cust-1', null);

    expect(result.hourlyRateCents).toBeNull();
  });

  it('updateHourlyRate() gooit een mensentaal-fout voor een onbestaande klant', async () => {
    const { prisma } = createFakePrisma([]);
    const service = new CustomerService(prisma);

    await expect(service.updateHourlyRate('does-not-exist', 6500)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });
});
