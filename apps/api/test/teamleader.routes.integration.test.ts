import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/modules/auth/password.service';

/**
 * Integratietest tegen een echte (test-)Postgres-database, net als
 * auth.integration.test.ts. Alle uitgaande calls náár Teamleader zelf
 * (token-exchange) worden gemockt via `global.fetch` — deze tests mogen
 * nooit een echte netwerkcall naar Teamleader maken.
 *
 * Vereist dezelfde env-variabelen als auth.integration.test.ts, plus de vier
 * TEAMLEADER_*-variabelen (zie README "Tests draaien" en
 * .github/workflows/ci.yml voor de vaste test-waarden — geen echte secrets,
 * enkel gebruikt tegen de gemockte fetch hieronder).
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
  await prisma.teamleaderConnection.deleteMany();
  await prisma.session.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.user.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function extractCookieValueByName(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const header of headers) {
    const pair = header.split(';')[0] ?? '';
    const [cookieName, cookieValue] = pair.split('=');
    if (cookieName === name) return cookieValue ?? '';
  }
  throw new Error(`Geen "${name}"-cookie gevonden in set-cookie headers.`);
}

async function loginAsAdmin(email = 'admin@swatt.be'): Promise<{ cookie: string; userId: string }> {
  const user = await createUser({ email, password: 'Str0ngPassw0rd!', role: 'ADMIN' });
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'Str0ngPassw0rd!' },
  });
  return { cookie: extractSessionCookie(response.headers['set-cookie']), userId: user.id };
}

function mockSuccessfulTokenExchange(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        access_token: 'access-test',
        refresh_token: 'refresh-test',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
      text: async () => '',
    })),
  );
}

describe('Teamleader OAuth-routes', () => {
  it('GET /teamleader/status vereist een sessie én de ADMIN-rol', async () => {
    const noSession = await app.inject({ method: 'GET', url: '/teamleader/status' });
    expect(noSession.statusCode).toBe(401);

    await createUser({ email: 'technieker@swatt.be', password: 'werfwachtwoord', role: 'EMPLOYEE' });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'technieker@swatt.be', password: 'werfwachtwoord' },
    });
    const employeeCookie = extractSessionCookie(loginResponse.headers['set-cookie']);

    const asEmployee = await app.inject({
      method: 'GET',
      url: '/teamleader/status',
      headers: { cookie: employeeCookie },
    });
    expect(asEmployee.statusCode).toBe(403);
    expect(asEmployee.json().error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('GET /teamleader/status geeft DISCONNECTED terug zolang er nog geen koppeling is', async () => {
    const { cookie } = await loginAsAdmin();
    const response = await app.inject({ method: 'GET', url: '/teamleader/status', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'DISCONNECTED', lastError: null });
  });

  it('GET
