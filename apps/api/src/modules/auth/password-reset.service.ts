import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AuthErrors } from '../../errors';
import { hashPassword } from './password.service';

/** Zelfde entropie als het Teamleader OAuth-handoff-token (zie teamleader.routes.ts). */
const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 uur

/**
 * Eén token-flow voor zowel "wachtwoord instellen bij uitnodiging" als
 * "wachtwoord vergeten" — zie de uitgebreide toelichting bij
 * PasswordSetupToken in schema.prisma.
 */
export class PasswordResetService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Maakt een nieuw token voor deze gebruiker. Bestaande, nog ongebruikte
   * tokens van eerdere aanvragen blijven gewoon nog (kort) geldig staan —
   * onschadelijk, want elk token is sowieso maar één keer bruikbaar
   * (`usedAt`) en heeft een korte levensduur. Geen opruimlogica nodig voor
   * dit MVP-schaalniveau.
   */
  async createToken(userId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await this.prisma.passwordSetupToken.create({
      data: { id: token, userId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    });
    return token;
  }

  /**
   * Valideert het token en zet meteen het nieuwe wachtwoord. Gooit
   * AuthErrors.invalidOrExpiredToken() bij een onbestaand/al-gebruikt/
   * verlopen token. Trekt bestaande sessies van deze gebruiker meteen in
   * (zelfde beveiligingsredenering als bij deactivatie in user.routes.ts):
   * een wachtwoordwijziging moet elders ingelogde sessies ongeldig maken.
   */
  async consumeToken(token: string, newPassword: string): Promise<void> {
    const record = await this.prisma.passwordSetupToken.findUnique({ where: { id: token } });
    if (!record || record.usedAt !== null || record.expiresAt < new Date()) {
      throw AuthErrors.invalidOrExpiredToken();
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.passwordSetupToken.update({ where: { id: token }, data: { usedAt: new Date() } }),
      this.prisma.session.deleteMany({ where: { userId: record.userId } }),
    ]);
  }
}
