import type { AuthenticatedUser, UserRole } from '@swatt/shared-types';
import { UserErrors } from '../../errors';
import type { UpdateUserBody } from './user.schemas';

/**
 * Klantvraag 7/10/2026: "supervisor moet ook medewerkers kunnen aanmaken en
 * beheren". Gebruikersbeheer staat daarom open vanaf SUPERVISOR, met deze
 * grenzen zodat een supervisor nooit zichzelf of een ander meer rechten kan
 * geven dan hij zelf heeft:
 *
 * 1. Een supervisor maakt/beheert enkel Werknemers en Supervisors — nooit een
 *    Administrator (aanmaken, promoveren of een bestaande beheerder wijzigen,
 *    deactiveren, verwijderen of opnieuw uitnodigen).
 * 2. Tarieven (kostprijs/verkoopprijs) blijven ADMIN-only: dat is
 *    boekhouding/facturatie (sectie 4), net als Facturatie en
 *    Personeelsuitbetaling. Supervisors krijgen die bedragen ook niet te zien.
 * 3. Niemand (ook geen admin) wijzigt zijn eigen rol of deactiveert/verwijdert
 *    zichzelf — voorkomt dat de enige beheerder zichzelf buitensluit.
 *
 * Bewust een puur-functionele module (geen Fastify/Prisma), zelfde aanpak als
 * rbac.middleware.ts — unit-testbaar zonder database (zie
 * test/user-management.policy.test.ts).
 */

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;
type Target = { id: string; role: UserRole };

function isAdmin(actor: Actor): boolean {
  return actor.role === 'ADMIN';
}

/** Mag deze gebruiker tarieven (kost-/verkoopprijs) zien en wijzigen? */
export function canManageRates(actor: Actor): boolean {
  return isAdmin(actor);
}

/** Welke rollen mag deze gebruiker toekennen (bij aanmaken of wijzigen)? */
export function assignableRoles(actor: Actor): UserRole[] {
  return isAdmin(actor) ? ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] : ['EMPLOYEE', 'SUPERVISOR'];
}

export function assertCanCreate(actor: Actor, role: UserRole): void {
  if (!assignableRoles(actor).includes(role)) {
    throw UserErrors.cannotAssignRole();
  }
}

/** Voor opnieuw uitnodigen, verwijderen en elke wijziging: mag deze gebruiker dit account überhaupt beheren? */
export function assertCanManageTarget(actor: Actor, target: Target): void {
  if (!isAdmin(actor) && target.role === 'ADMIN') {
    throw UserErrors.cannotManageAdmin();
  }
}

export function assertCanUpdate(actor: Actor, target: Target, body: UpdateUserBody): void {
  assertCanManageTarget(actor, target);

  if (body.role !== undefined && !assignableRoles(actor).includes(body.role)) {
    throw UserErrors.cannotAssignRole();
  }

  if (actor.id === target.id) {
    if (body.role !== undefined && body.role !== target.role) {
      throw UserErrors.cannotChangeOwnAccess();
    }
    if (body.isActive === false) {
      throw UserErrors.cannotChangeOwnAccess();
    }
  }

  if (!canManageRates(actor) && (body.payrollRateCents !== undefined || body.defaultHourlyRateCents !== undefined)) {
    throw UserErrors.ratesAdminOnly();
  }
}

export function assertCanDelete(actor: Actor, target: Target): void {
  assertCanManageTarget(actor, target);
  if (actor.id === target.id) {
    throw UserErrors.cannotChangeOwnAccess();
  }
}
