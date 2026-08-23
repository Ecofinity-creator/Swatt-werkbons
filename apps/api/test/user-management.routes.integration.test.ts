import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/modules/auth/password.service';

/**
 * Integratietest tegen een echte (test-)Postgres-database, zelfde patroon als
 * auth.integration.test.ts. Test hier bewust ENKEL onze eigen
 * gebruikersbeheer-routes (/admin/users, .../update) — geen enkele Teamleader-
 * aanroep hierin, dus geen fetch-mock nodig (zie teamleader.routes.integration.test.ts
 * voor dat patroon).
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
  await prisma.session.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.user.deleteMany();
});

async function createUser(overrides: {
  email: string;
  password: string;
  role: 'EMPLOYEE' | 'SUPERVISOR' | 'ADMIN';
}) {
  return prisma.user.create({
    data: {
      email: overrides.email,
      passwordHash: await hashPassword(overrides.password),
      role: overrides.role,
      employee: { create: { displayName: overrides.email.split('@')[0] ?? 'Test' } },
    },
  });
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('Geen set-cookie header ontvangen — kan sessie niet doortesten.');
  return raw.split(';')[0] ?? '';
}

async function loginAs(email: string, password: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  return extractSessionCookie(response.headers['set-cookie']);
}

async function loginAsAdmin(): Promise<string> {
  await createUser({ email: 'admin@swatt.be', password: 'Str0ngPassw0rd!', role: 'ADMIN' });
  return loginAs('admin@swatt.be', 'Str0ngPassw0rd!');
}

describe('Admin gebruikersbeheer (/admin/users)', () => {
  it('GET en POST /admin/users vereisen de ADMIN-rol (niet enkel een sessie)', async () => {
    await createUser({ email: 'supervisor@swatt.be', password: 'wachtwoord123', role: 'SUPERVISOR' });
    const cookie = await loginAs('supervisor@swatt.be', 'wachtwoord123');

    const list = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.code).toBe('INSUFFICIENT_ROLE');

    const create = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie },
      payload: { email: 'nieuw@swatt.be', password: 'wachtwoord123', displayName: 'Nieuw', role: 'EMPLOYEE' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('een ADMIN kan een nieuwe gebruiker aanmaken (met meteen een Employee-profiel) en die verschijnt in de lijst', async () => {
    const cookie = await loginAsAdmin();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie },
      payload: {
        email: 'peter@swatt.be',
        password: 'werfwachtwoord1',
        displayName: 'Peter',
        role: 'EMPLOYEE',
        phone: '0470 12 34 56',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().user;
    expect(created.email).toBe('peter@swatt.be');
    expect(created.role).toBe('EMPLOYEE');
    expect(created.isActive).toBe(true);
    expect(created.employee).toMatchObject({ displayName: 'Peter', phone: '0470 12 34 56' });
    expect(created).not.toHaveProperty('passwordHash');
    expect(created).not.toHaveProperty('password');

    // De nieuwe gebruiker kan meteen inloggen met het door de admin gekozen wachtwoord.
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'peter@swatt.be', password: 'werfwachtwoord1' },
    });
    expect(loginResponse.statusCode).toBe(200);

    const listResponse = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } });
    const emails = listResponse.json().users.map((u: { email: string }) => u.email);
    expect(emails).toContain('peter@swatt.be');
  });

  it('weigert een tweede gebruiker met hetzelfde e-mailadres met een mensentaal-foutmelding', async () => {
    const cookie = await loginAsAdmin();
    const payload = { email: 'dubbel@swatt.be', password: 'werfwachtwoord1', displayName: 'Eerste', role: 'EMPLOYEE' };

    const first = await app.inject({ method: 'POST', url: '/admin/users', headers: { cookie }, payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: { cookie },
      payload: { ...payload, displayName: 'Tweede' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('EMAIL_ALREADY_IN_USE');
  });

  it('POST /admin/users/:id/update kan rol en actief-status wijzigen, en trekt sessies in bij deactivatie', async () => {
    const adminCookie = await loginAsAdmin();
    const wannes = await createUser({ email: 'wannes@swatt.be', password: 'werfwachtwoord2', role: 'EMPLOYEE' });
    const wannesCookie = await loginAs('wannes@swatt.be', 'werfwachtwoord2');

    // Wannes is nog gewoon ingelogd vóór de deactivatie.
    const meBefore = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: wannesCookie } });
    expect(meBefore.statusCode).toBe(200);

    const updateResponse = await app.inject({
      method: 'POST',
      url: `/admin/users/${wannes.id}/update`,
      headers: { cookie: adminCookie },
      payload: { role: 'SUPERVISOR', isActive: false },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().user).toMatchObject({ role: 'SUPERVISOR', isActive: false });

    // Business rule: deactivatie trekt bestaande sessies meteen in (Session-model-commentaar).
    const meAfter = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: wannesCookie } });
    expect(meAfter.statusCode).toBe(401);
  });

  it('geeft een duidelijke 404 bij een niet-bestaande gebruiker', async () => {
    const cookie = await loginAsAdmin();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/users/00000000-0000-4000-8000-000000000099/update',
      headers: { cookie },
      payload: { role: 'ADMIN' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('USER_NOT_FOUND');
  });
});
