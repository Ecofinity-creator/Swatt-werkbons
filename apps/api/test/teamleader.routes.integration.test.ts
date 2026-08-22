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

  it('GET /teamleader/oauth/authorize stuurt een ADMIN naar Teamleader met een state-cookie', async () => {
    const { cookie } = await loginAsAdmin();
    const response = await app.inject({ method: 'GET', url: '/teamleader/oauth/authorize', headers: { cookie } });

    expect(response.statusCode).toBe(302);
    const location = response.headers['location'] as string;
    expect(location.startsWith('https://focus.teamleader.eu/oauth2/authorize')).toBe(true);
    expect(location).toContain('response_type=code');
    expect(location).toContain('state=');

    const stateCookieValue = extractCookieValueByName(response.headers['set-cookie'], 'swatt_tl_oauth_state');
    expect(stateCookieValue.length).toBeGreaterThan(10);
  });

  it('GET /teamleader/oauth/authorize weigert een niet-ADMIN', async () => {
    await createUser({ email: 'technieker3@swatt.be', password: 'werfwachtwoord', role: 'EMPLOYEE' });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'technieker3@swatt.be', password: 'werfwachtwoord' },
    });
    const cookie = extractSessionCookie(loginResponse.headers['set-cookie']);

    const response = await app.inject({ method: 'GET', url: '/teamleader/oauth/authorize', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it('volledige koppeling: authorize → callback → status CONNECTED, met correcte connectedByUserId', async () => {
    const { cookie, userId } = await loginAsAdmin();

    const authorizeResponse = await app.inject({
      method: 'GET',
      url: '/teamleader/oauth/authorize',
      headers: { cookie },
    });
    const stateCookie = `swatt_tl_oauth_state=${extractCookieValueByName(
      authorizeResponse.headers['set-cookie'],
      'swatt_tl_oauth_state',
    )}`;
    const location = new URL(authorizeResponse.headers['location'] as string);
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    mockSuccessfulTokenExchange();

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/teamleader/oauth/callback?code=test-code&state=${state}`,
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers['location']).toContain('teamleaderConnected=1');

    const statusResponse = await app.inject({ method: 'GET', url: '/teamleader/status', headers: { cookie } });
    expect(statusResponse.json()).toMatchObject({ status: 'CONNECTED' });

    const row = await prisma.teamleaderConnection.findFirst();
    expect(row?.connectedByUserId).toBe(userId);
    // Nooit de platte tokenwaarde in de database.
    expect(row?.accessTokenEncrypted?.toString('utf8')).not.toContain('access-test');
  });

  it('callback met een verkeerde state redirect met teamleaderError=STATE_MISMATCH (CSRF-bescherming)', async () => {
    const { cookie } = await loginAsAdmin();

    const authorizeResponse = await app.inject({
      method: 'GET',
      url: '/teamleader/oauth/authorize',
      headers: { cookie },
    });
    const stateCookie = `swatt_tl_oauth_state=${extractCookieValueByName(
      authorizeResponse.headers['set-cookie'],
      'swatt_tl_oauth_state',
    )}`;

    const callbackResponse = await app.inject({
      method: 'GET',
      url: '/teamleader/oauth/callback?code=test-code&state=dit-klopt-niet',
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers['location']).toContain('teamleaderError=STATE_MISMATCH');

    const status = await prisma.teamleaderConnection.findFirst();
    expect(status).toBeNull();
  });

  it('callback met error=access_denied (klant weigert in Teamleader) redirect met teamleaderError=DENIED', async () => {
    const response = await app.inject({ method: 'GET', url: '/teamleader/oauth/callback?error=access_denied' });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('teamleaderError=DENIED');
  });

  it('POST /teamleader/oauth/disconnect vereist ADMIN en verbreekt daarna de koppeling', async () => {
    await createUser({ email: 'technieker4@swatt.be', password: 'werfwachtwoord', role: 'EMPLOYEE' });
    const employeeLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'technieker4@swatt.be', password: 'werfwachtwoord' },
    });
    const employeeCookie = extractSessionCookie(employeeLogin.headers['set-cookie']);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/teamleader/oauth/disconnect',
      headers: { cookie: employeeCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const { cookie } = await loginAsAdmin();
    const response = await app.inject({
      method: 'POST',
      url: '/teamleader/oauth/disconnect',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);

    const status = await app.inject({ method: 'GET', url: '/teamleader/status', headers: { cookie } });
    expect(status.json()).toMatchObject({ status: 'DISCONNECTED' });
  });
});
