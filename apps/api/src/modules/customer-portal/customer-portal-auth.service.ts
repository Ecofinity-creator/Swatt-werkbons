import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { CustomerPortalErrors } from '../../errors';

/** Zelfde entropie als het bestaande wachtwoord-reset-token (zie auth/password-reset.service.ts). */
const TOKEN_BYTES = 32;
/** Korter dan het wachtwoord-reset-token (1 uur) — een inloglink is bedoeld om meteen na ontvangst te gebruiken, niet als iets om dagen te bewaren. */
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minuten

export interface CustomerIdentity {
  id: string;
  name: string;
}

/**
 * Klantportaal (sectie 30) — magic-link-login per e-mailadres, geen
 * wachtwoord. Zelfde eenmalig-bruikbaar-tokenpatroon als
 * PasswordResetService, maar volledig los van de medewerker-auth: een
 * Customer is geen User.
 */
export class CustomerPortalAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Case-insensitive opzoeking — Teamleader-e-mailadressen worden precies
   * zo gesynchroniseerd als ze daar staan (zie ProjectSyncService), een
   * klant typt dit zelf in en verwacht geen hoofdlettergevoeligheid.
   * `null` wanneer geen (of geen actief e-mailadres bij) klant gevonden —
   * de route-laag behandelt dit als "altijd hetzelfde antwoord" (anti-
   * enumeratie, zelfde redenering als AuthService.login()/forgot-password).
   */
  async findCustomerByEmail(email: string): Promise<CustomerIdentity | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    return customer;
  }

  async createLoginToken(customerId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.prisma.customerLoginToken.create({
      data: { id: token, customerId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    });
    return token;
  }

  /** Valideert en verbruikt het token (eenmalig bruikbaar) — gooit CustomerPortalErrors.invalidOrExpiredToken() bij een onbestaand/al-gebruikt/verlopen token. Maakt zelf nog geen sessie aan — dat doet de route-laag via CustomerPortalSessionService, zodat dit hier puur tokenvalidatie blijft. */
  async consumeLoginToken(token: string): Promise<CustomerIdentity> {
    const record = await this.prisma.customerLoginToken.findUnique({
      where: { id: token },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!record || record.usedAt !== null || record.expiresAt < new Date()) {
      throw CustomerPortalErrors.invalidOrExpiredToken();
    }
    await this.prisma.customerLoginToken.update({ where: { id: token }, data: { usedAt: new Date() } });
    return record.customer;
  }
}
