import type {
  AdminUserSummary,
  CreateUserResponseBody,
  ListUsersResponseBody,
  UpdateUserResponseBody,
  UserRole,
} from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserErrors } from '../../errors';
import { buildInviteEmail } from '../auth/auth-emails';
import { requireRole } from '../rbac/rbac.middleware';
import { createUserBodySchema, updateUserBodySchema } from './user.schemas';

const userIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Admin-only gebruikersbeheer (Stap 5.2, backoffice-scherm "Medewerkers").
 * Elke nieuwe gebruiker krijgt hier meteen een Employee-profiel (net als de
 * eenmalige /admin/seed-route) — er bestaat in deze app bewust geen apart
 * "gebruiker zonder werknemersprofiel"-pad; zie het commentaar bij het
 * Employee-model in schema.prisma.
 *
 * Wachtwoord: de admin kiest hier GEEN wachtwoord meer — een nieuwe
 * gebruiker krijgt `passwordHash: null` en meteen een uitnodigingsmail met
 * een link om zelf een wachtwoord in te stellen (zie password-reset.service.ts
 * / auth-emails.ts). Dit vervangt het eerdere patroon (admin deelt zelf een
 * wachtwoord mee) nu er wél e-mailverzendings-infrastructuur is (Resend).
 */
export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/users',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (): Promise<ListUsersResponseBody> => {
      const users = await app.prisma.user.findMany({
        include: { employee: true },
        orderBy: { createdAt: 'asc' },
      });
      return { users: users.map(toAdminUserSummary) };
    },
  );

  app.post(
    '/admin/users',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request, reply): Promise<CreateUserResponseBody> => {
      const body = createUserBodySchema.parse(request.body);

      const existing = await app.prisma.user.findUnique({ where: { email: body.email } });
      if (existing) {
        throw UserErrors.emailAlreadyInUse();
      }

      const user = await app.prisma.user.create({
        data: {
          email: body.email,
          passwordHash: null,
          role: body.role,
          employee: { create: { displayName: body.displayName, phone: body.phone ?? null } },
        },
        include: { employee: true },
      });

      // Account blijft sowieso aangemaakt, zelfs als de uitnodigingsmail
      // faalt (bv. e-maildienst nog niet geconfigureerd) — business rule 9
      // (externe-dienst-storing mag nooit lokale data laten verloren gaan).
      // De admin ziet dat via `inviteEmailSent` en kan de gebruiker vragen
      // om zelf "Wachtwoord vergeten" te gebruiken zodra dat wel lukt.
      let inviteEmailSent = true;
      try {
        const token = await app.passwordResetService.createToken(user.id);
        await app.emailService.send(buildInviteEmail(body.email, token, body.displayName));
      } catch (err) {
        inviteEmailSent = false;
        request.log.error({ err }, 'Versturen van uitnodigingsmail mislukt');
      }

      reply.code(201);
      return { user: toAdminUserSummary(user), inviteEmailSent };
    },
  );

  // Bewust POST i.p.v. PATCH — zie het commentaar bovenaan shared-types over
  // CORS-preflights die deze app structureel vermijdt (Render's edge-404-bug,
  // zie apps/api/src/app.ts).
  app.post(
    '/admin/users/:id/update',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<UpdateUserResponseBody> => {
      const params = userIdParamsSchema.parse(request.params);
      const body = updateUserBodySchema.parse(request.body);

      const existing = await app.prisma.user.findUnique({ where: { id: params.id }, include: { employee: true } });
      if (!existing) {
        throw UserErrors.notFound();
      }

      if (body.role !== undefined || body.isActive !== undefined) {
        await app.prisma.user.update({
          where: { id: params.id },
          data: {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          },
        });

        // Deactivatie moet meteen effect hebben — bestaande sessies blijven
        // anders geldig tot hun natuurlijke verval (zie ook het commentaar
        // bij Session in schema.prisma: "op elk moment serverzijdig
        // ingetrokken kan worden — bv. bij het deactiveren van een gebruiker").
        if (body.isActive === false) {
          await app.prisma.session.deleteMany({ where: { userId: params.id } });
        }
      }

      if (body.displayName !== undefined || body.phone !== undefined) {
        if (!existing.employee) {
          // Kan in de praktijk niet voorkomen (elke gebruiker krijgt bij aanmaak
          // een Employee-profiel), maar defensief afgehandeld i.p.v. te crashen.
          throw UserErrors.notFound();
        }
        await app.prisma.employee.update({
          where: { userId: params.id },
          data: {
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body.phone !== undefined ? { phone: body.phone } : {}),
          },
        });
      }

      const updated = await app.prisma.user.findUniqueOrThrow({
        where: { id: params.id },
        include: { employee: true },
      });
      return { user: toAdminUserSummary(updated) };
    },
  );
}

// Bewust een handgeschreven structureel type i.p.v. het gegenereerde Prisma
// User/Employee-type rechtstreeks te importeren — zelfde patroon als
// `toAuthenticatedUser` in auth/auth.service.ts: deze mapper-functie is zo
// onafhankelijk testbaar en geeft nooit per ongeluk een `passwordHash` e.d. door.
function toAdminUserSummary(user: {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  employee: { id: string; displayName: string; phone: string | null } | null;
}): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    employee: user.employee
      ? { id: user.employee.id, displayName: user.employee.displayName, phone: user.employee.phone }
      : null,
    createdAt: user.createdAt.toISOString(),
  };
}
