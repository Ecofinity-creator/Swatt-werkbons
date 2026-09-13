import type { PrismaClient } from '@prisma/client';

export const CUSTOMER_PORTAL_SESSION_COOKIE_NAME = 'swatt_customer_session';
/** Een klant logt hoogstwaarschijnlijk maar af en toe in (na elke werkbon/maand) — een langere duur dan de medewerker-sessie (7 dagen) is hier gepaster, zodat niet elke keer een nieuwe magic-link nodig is. */
const CUSTOMER_SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 dagen

export interface CustomerSessionInfo {
  sessionId: string;
  customerId: string;
  expiresAt: Date;
}

/**
 * Server-side sessies voor het klantportaal (sectie 30) — zelfde filosofie
 * als SessionService (auth/session.service.ts) voor medewerkers: intrekbaar
 * op elk moment, bewust géén JWT-in-cookie. Een volledig apart model/tabel
 * (CustomerSession, niet Session) zodat een klant-sessie nooit, via welke
 * bug dan ook, een medewerker-sessie-ID zou kunnen zijn of omgekeerd.
 */
export class CustomerPortalSessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async createSession(customerId: string): Promise<CustomerSessionInfo> {
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_DURATION_MS);
    const session = await this.prisma.customerSession.create({ data: { customerId, expiresAt } });
    return { sessionId: session.id, customerId: session.customerId, expiresAt: session.expiresAt };
  }

  async findValidSession(sessionId: string): Promise<CustomerSessionInfo | null> {
    const session = await this.prisma.customerSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return null;
    }
    return { sessionId: session.id, customerId: session.customerId, expiresAt: session.expiresAt };
  }

  async deleteSession(sessionId: string): Promise<void> {
    // deleteMany i.p.v. delete: idempotent, geen error bij een dubbele logout-klik.
    await this.prisma.customerSession.deleteMany({ where: { id: sessionId } });
  }
}
