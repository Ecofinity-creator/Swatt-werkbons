import type { PrismaClient } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'swatt_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 dagen

export interface SessionInfo {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Server-side sessies (opgeslagen in Postgres, zie prisma/schema.prisma → Session).
 * Bewust géén JWT-in-cookie: zo kan een sessie op elk moment serverzijdig
 * ingetrokken worden (bv. wanneer een admin een gebruiker deactiveert),
 * zonder te moeten wachten tot een token vanzelf verloopt.
 */
export class SessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async createSession(userId: string): Promise<SessionInfo> {
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    const session = await this.prisma.session.create({
      data: { userId, expiresAt },
    });
    return { sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt };
  }

  async findValidSession(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return null;
    }
    return { sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt };
  }

  async deleteSession(sessionId: string): Promise<void> {
    // deleteMany i.p.v. delete: idempotent, geen error als de sessie al weg is
    // (bv. dubbele logout-klik).
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /** Opruimtaak voor verlopen sessies — later aan een cron/BullMQ-job te hangen. */
  async purgeExpiredSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}
