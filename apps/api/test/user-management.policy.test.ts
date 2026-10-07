import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import {
  assertCanCreate,
  assertCanDelete,
  assertCanManageTarget,
  assertCanUpdate,
  assignableRoles,
  canManageRates,
} from '../src/modules/users/user-management.policy';

const admin = { id: 'admin-1', role: 'ADMIN' as const };
const supervisor = { id: 'sup-1', role: 'SUPERVISOR' as const };
const worker = { id: 'emp-1', role: 'EMPLOYEE' as const };
const otherAdmin = { id: 'admin-2', role: 'ADMIN' as const };

function errorCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
}

describe('Gebruikersbeheer door een supervisor (klantvraag 7/10/2026)', () => {
  it('mag werknemers en supervisors aanmaken, maar geen administrators', () => {
    expect(errorCode(() => assertCanCreate(supervisor, 'EMPLOYEE'))).toBeNull();
    expect(errorCode(() => assertCanCreate(supervisor, 'SUPERVISOR'))).toBeNull();
    expect(errorCode(() => assertCanCreate(supervisor, 'ADMIN'))).toBe('USER_CANNOT_ASSIGN_ROLE');
    expect(assignableRoles(supervisor)).toEqual(['EMPLOYEE', 'SUPERVISOR']);
  });

  it('mag een werknemer beheren (naam, rol tot supervisor, deactiveren, verwijderen)', () => {
    expect(
      errorCode(() =>
        assertCanUpdate(supervisor, worker, {
          displayName: 'Peter',
          role: 'SUPERVISOR',
          isActive: false,
        }),
      ),
    ).toBeNull();
    expect(errorCode(() => assertCanDelete(supervisor, worker))).toBeNull();
  });

  it('kan niemand tot administrator promoveren', () => {
    expect(errorCode(() => assertCanUpdate(supervisor, worker, { role: 'ADMIN' }))).toBe('USER_CANNOT_ASSIGN_ROLE');
  });

  it('kan een bestaande administrator op geen enkele manier beheren', () => {
    expect(errorCode(() => assertCanManageTarget(supervisor, otherAdmin))).toBe('USER_CANNOT_MANAGE_ADMIN');
    expect(errorCode(() => assertCanUpdate(supervisor, otherAdmin, { displayName: 'x' }))).toBe(
      'USER_CANNOT_MANAGE_ADMIN',
    );
    expect(errorCode(() => assertCanUpdate(supervisor, otherAdmin, { isActive: false }))).toBe(
      'USER_CANNOT_MANAGE_ADMIN',
    );
    expect(errorCode(() => assertCanDelete(supervisor, otherAdmin))).toBe('USER_CANNOT_MANAGE_ADMIN');
  });

  it('kan geen tarieven zien of instellen', () => {
    expect(canManageRates(supervisor)).toBe(false);
    expect(errorCode(() => assertCanUpdate(supervisor, worker, { payrollRateCents: 4500 }))).toBe(
      'USER_RATES_ADMIN_ONLY',
    );
    expect(errorCode(() => assertCanUpdate(supervisor, worker, { defaultHourlyRateCents: 6500 }))).toBe(
      'USER_RATES_ADMIN_ONLY',
    );
  });
});

describe('Eigen toegang (geldt voor iedereen)', () => {
  it('niemand wijzigt zijn eigen rol, deactiveert of verwijdert zichzelf', () => {
    expect(errorCode(() => assertCanUpdate(admin, admin, { role: 'EMPLOYEE' }))).toBe('USER_CANNOT_CHANGE_OWN_ACCESS');
    expect(errorCode(() => assertCanUpdate(admin, admin, { isActive: false }))).toBe('USER_CANNOT_CHANGE_OWN_ACCESS');
    expect(errorCode(() => assertCanDelete(admin, admin))).toBe('USER_CANNOT_CHANGE_OWN_ACCESS');
    expect(errorCode(() => assertCanUpdate(supervisor, supervisor, { role: 'EMPLOYEE' }))).toBe(
      'USER_CANNOT_CHANGE_OWN_ACCESS',
    );
  });

  it('eigen naam/telefoon aanpassen mag wel, en "dezelfde rol opnieuw opslaan" is geen wijziging', () => {
    expect(
      errorCode(() =>
        assertCanUpdate(supervisor, supervisor, {
          displayName: 'Nieuwe naam',
          phone: '0470',
        }),
      ),
    ).toBeNull();
    expect(errorCode(() => assertCanUpdate(admin, admin, { role: 'ADMIN' }))).toBeNull();
  });
});

describe('Administrator', () => {
  it('behoudt alle rechten op andere gebruikers, inclusief andere admins en tarieven', () => {
    expect(errorCode(() => assertCanCreate(admin, 'ADMIN'))).toBeNull();
    expect(errorCode(() => assertCanUpdate(admin, otherAdmin, { isActive: false }))).toBeNull();
    expect(
      errorCode(() =>
        assertCanUpdate(admin, worker, {
          payrollRateCents: 4500,
          role: 'ADMIN',
        }),
      ),
    ).toBeNull();
    expect(errorCode(() => assertCanDelete(admin, otherAdmin))).toBeNull();
  });
});
