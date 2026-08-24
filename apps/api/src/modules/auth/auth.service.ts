import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '@swatt/shared-types';
import { AuthErrors } from '../../errors';
import { verifyPassword } from './password.service';
import { SessionService } from './session.service';

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Valideert credentials en start een sessie.
   * Gooit bewust dezelfde `invalidCredentials`-fout of het account nu niet
   * bestaat, of het wachtwoord fout is — nooit onthullen of een e-mailadres
   * bestaat (voorkomt account-enumeratie).
   */
  async login(
    email: string,
    password: string,
    rememberMe = false,
  ): Promise<{ sessionId: string; user: AuthenticatedUser; expiresAt: Date }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { employee: true },
    });

    if (!user) {
      throw AuthErrors.invalidCredentials();
    }

    if (user.passwordHash === null) {
      // Uitgenodigd, maar nog geen wachtwoord ingesteld (zie user.routes.ts
      // / password-reset.service.ts) — expliciet onderscheiden van
      // "invalid credentials", zie de toelichting bij passwordNotSet() in errors.ts.
      throw AuthErrors.passwordNotSet();
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw AuthErrors.invalidCredentials();
    }

    if (!user.isActive) {
      throw AuthErrors.accountDeactivated();
    }

    const session = await this.sessions.createSession(user.id, rememberMe);

    return { sessionId: session.sessionId, user: toAuthenticatedUser(user), expiresAt: session.expiresAt };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.deleteSession(sessionId);
  }

  async getCurrentUser(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!user) return null;
    return toAuthenticatedUser(user);
  }
}

// Prisma's gegenereerde User-type (met optionele employee-relatie) is intern aan deze module;
// we geven nooit het ruwe Prisma-object naar buiten (bevat o.a. passwordHash).
function toAuthenticatedUser(user: {
  id: string;
  email: string;
  role: 'EMPLOYEE' | 'SUPERVISOR' | 'ADMIN';
  isActive: boolean;
  employee: { id: string; displayName: string } | null;
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    employee: user.employee ? { id: user.employee.id, displayName: user.employee.displayName } : null,
  };
}
