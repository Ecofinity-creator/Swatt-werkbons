import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/modules/auth/password.service';

/**
 * Integratietest tegen een echte (test-)Postgres-database — geen mocks voor
 * Prisma zelf, wél volledig los van Teamleader (die komt pas vanaf Phase 2).
 * Vereist dat DATABASE_URL naar een leeg te maken test-database wijst
 * (zie package.json test-script / README "Tests draaien").
 */

let app: FastifyInstance;
let prisma: PrismaClient;

beforeAll(async () => {
  app = await buildApp();
  prisma = app.prisma;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Volledig schone lei per test — voorkomt volgorde-afhankelijke tests.
  await prisma.session.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.user.deleteMany();
});

async function createUser(overrides: {
  email: string;
  password: string;
  role: 'EMPLOYEE' | 'SUPERVISOR' | 'ADMIN';
  isActive?: boolean;
}) {
  return prisma.user.create({
    data: {
      email: overrides.email,
      passwordHash: await hashPassword(overrides.password),
      role: overrides.role,
      isActive: overrides.isActive ?? true,
      employee: { create: { displayName: overrides.email.split('@')[0] ?? 'Test' } },
    },
  });
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('Geen set-cookie header ontvangen — kan sessie niet doortesten.');
  return raw.split(';')[0] ?? '';
}

describe('Auth-flow: login → me → logout', () => {
  it('laat een admin-gebruiker inloggen en zichzelf terugvinden via /auth/me', async () => {
    await createUser({ email: 'admin@swatt.be', password: 'Str0ngPassw0rd!', role: 'ADMIN' });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@swatt.be', password: 'Str0ngPassw0rd!' },
    });

    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json();
    expect(loginBody.user.email).toBe('admin@swatt.be');
    expect(loginBody.user.role).toBe('ADMIN');
    expect(loginBody.user).not.toHaveProperty('passwordHash');

    const cookie = extractSessionCookie(loginResponse.headers['set-cookie']);

    const meResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().user.email).toBe('admin@swatt.be');

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(204);

    // Na logout is de sessie serverzijdig ingetrokken: /auth/me moet nu 401 geven.
    const meAfterLogout = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(meAfterLogout.statusCode).toBe(401);
  });

  it('geeft een mensentaal-foutmelding bij een verkeerd wachtwoord (geen kale HTTP-code)', async () => {
    await createUser({ email: 'peter@swatt.be', password: 'correct-horse', role: 'EMPLOYEE' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'peter@swatt.be', password: 'fout-wachtwoord' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'E-mailadres of wachtwoord is onjuist.' },
    });
  });

  it('weigert een gedeactiveerde gebruiker met een duidelijke melding', async () => {
    await createUser({
      email: 'oud-medewerker@swatt.be',
      password: 'geheim123',
      role: 'EMPLOYEE',
      isActive: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'oud-medewerker@swatt.be', password: 'geheim123' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('business rule: RBAC afgedwongen tot op HTTP-niveau (EMPLOYEE krijgt 403 op een admin-route)', async () => {
    await createUser({ email: 'technieker@swatt.be', password: 'werfwachtwoord', role: 'EMPLOYEE' });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'technieker@swatt.be', password: 'werfwachtwoord' },
    });
    const cookie = extractSessionCookie(loginResponse.headers['set-cookie']);

    const pingAsEmployee = await app.inject({ method: 'GET', url: '/admin/ping', headers: { cookie } });
    expect(pingAsEmployee.statusCode).toBe(403);
    expect(pingAsEmployee.json().error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('business rule: een ADMIN krijgt wél toegang tot een admin-route', async () => {
    await createUser({ email: 'baas@swatt.be', password: 'adminwachtwoord', role: 'ADMIN' });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'baas@swatt.be', password: 'adminwachtwoord' },
    });
    const cookie = extractSessionCookie(loginResponse.headers['set-cookie']);

    const pingAsAdmin = await app.inject({ method: 'GET', url: '/admin/ping', headers: { cookie } });
    expect(pingAsAdmin.statusCode).toBe(200);
    expect(pingAsAdmin.json()).toEqual({ pong: true });
  });

  it('weigert toegang zonder sessie-cookie met een duidelijke melding i.p.v. een kale 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('NOT_AUTHENTICATED');
  });
});
