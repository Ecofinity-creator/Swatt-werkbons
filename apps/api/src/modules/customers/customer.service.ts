import type { PrismaClient } from '@prisma/client';
import { CustomerErrors } from '../../errors';

export interface CustomerRecord {
  id: string;
  name: string;
  hourlyRateCents: number | null;
}

/**
 * Phase 10b — enkel het uurtarief-veld (Customer.hourlyRateCents), zie
 * claude/phase10-facturatie-onderzoek.md: Steven koos "tarief per klant"
 * (afgesproken via offerte) i.p.v. een vast bedrijfsbreed tarief of een
 * tarief per werk-type. Klanten zelf blijven Teamleader-masterdata (sectie
 * 2) — deze service beheert bewust NIET naam/adres/btw-nummer, enkel het
 * lokale tarief-veld dat Teamleader niet kent.
 */
export class CustomerService {
  constructor(private readonly prisma: PrismaClient) {}

  async updateHourlyRate(customerId: string, hourlyRateCents: number | null): Promise<CustomerRecord> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw CustomerErrors.notFound();
    }
    return this.prisma.customer.update({
      where: { id: customerId },
      data: { hourlyRateCents },
      select: { id: true, name: true, hourlyRateCents: true },
    });
  }
}
