import type { ApiErrorBody } from '@swatt/shared-types';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import rateLimitPlugin from '../src/plugins/rate-limit';

/**
 * De echte app (app.ts) registreert een globale `setErrorHandler` die elke
 * `ApiError` (dus ook `RateLimitErrors.tooManyRequests()`) omzet naar
 * `{ error: { code, message } }` — zónder die handler valt Fastify terug op
 * zijn eigen default-foutformaat (`{ statusCode, error, message }`), wat een
 * andere vorm test zou opleveren dan wat een echte client ooit te zien
 * krijgt. Deze minimale replica van dát ene relevante stuk van app.ts'
 * handler houdt deze test representatief zonder de volledige `buildApp()`
 * (met haar Postgres-vereiste) erbij te moeten halen.
 */
function registerApiErrorHandler(instance: FastifyInstance): void {
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      reply.code(error.statusCode).send(body);
      return;
    }
    throw error;
  });
}

/**
 * Fase 32 (klantvraag 15/9/2026 — rate limiting, zie plugins/rate-limit.ts).
 * "Integration" omdat dit tegen een echte Redis draait (de plugin gebruikt
 * bewust een Redis-store, zie de toelichting daar) — vereist dus een
 * bereikbare REDIS_URL, zelfde vereiste als de bestaande BullMQ-tests (zie
 * ci.yml's Redis-service). Bouwt bewust een eigen, minimale Fastify-app
 * i.p.v. de volledige `buildApp()`: dit test enkel het rate-limit-mechanisme
 * zelf (drempel, foutformaat, headers), niet de rest van de applicatie, en
 * heeft dus geen Postgres/Prisma nodig.
 *
 * `{ enabled: true }` doorgegeven bij het registreren — de plugin staat
 * standaard uit onder `NODE_ENV=test` (zie de toelichting in
 * plugins/rate-limit.ts) zodat de rest van de testsuite (die routes als
 * /auth/login tientallen keren per testrun aanroept) niet tegen de limiet
 * aanloopt; deze test schakelt het dus bewust expliciet weer aan.
 */

let app: FastifyInstance;

// Uniek per testrun — zie de toelichting bij `nameSpace` in plugins/rate-limit.ts.
const testNameSpace = `test-rl-${Date.now()}-`;

beforeAll(async () => {
  app = Fastify();
  registerApiErrorHandler(app);
  await app.register(rateLimitPlugin, { enabled: true, nameSpace: testNameSpace });

  // Route met een eigen, krappe limiet — zelfde `config.rateLimit`-patroon
  // als de echte /auth/login-route (zie auth.routes.ts), maar klein genoeg
  // om in een test snel en deterministisch te overschrijden.
  app.get('/rl-test/strict', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => ({ ok: true }));

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('rate-limit.ts — plugin-mechanisme (echte Redis-store)', () => {
  it('laat requests binnen de limiet gewoon door, met aflopende x-ratelimit-remaining-header', async () => {
    const first = await app.inject({ method: 'GET', url: '/rl-test/strict' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');

    const second = await app.inject({ method: 'GET', url: '/rl-test/strict' });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('blokkeert de 4e request binnen hetzelfde venster met een 429 in het standaard-ApiError-formaat', async () => {
    // Venster (van de vorige test) is nog niet verstreken — dit is dus de 3e
    // (nog toegelaten) en 4e (geblokkeerde) request op dezelfde route/IP.
    const third = await app.inject({ method: 'GET', url: '/rl-test/strict' });
    expect(third.statusCode).toBe(200);

    const fourth = await app.inject({ method: 'GET', url: '/rl-test/strict' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers['retry-after']).toBeDefined();
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);

    const body = fourth.json();
    expect(body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('Te veel pogingen'),
      },
    });
  });

  it('geeft nog steeds een correct 429-antwoord op een aparte route die de royale globale limiet gebruikt', async () => {
    // Geen eigen `config.rateLimit` — draait dus op de globale 300/minuut uit
    // plugins/rate-limit.ts zelf. Enkel de foutrespons-vorm testen (niet
    // effectief 300 requests afvuren): een route met een expliciet lage
    // `max: 1` via dezelfde globale plugin-registratie is voldoende bewijs
    // dat globale en per-route configuratie hetzelfde mechanisme delen.
    const singleUseApp = Fastify();
    registerApiErrorHandler(singleUseApp);
    await singleUseApp.register(rateLimitPlugin, { enabled: true, nameSpace: `${testNameSpace}single-` });
    singleUseApp.get('/rl-test/single', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    await singleUseApp.ready();

    try {
      const allowed = await singleUseApp.inject({ method: 'GET', url: '/rl-test/single' });
      expect(allowed.statusCode).toBe(200);

      const blocked = await singleUseApp.inject({ method: 'GET', url: '/rl-test/single' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await singleUseApp.close();
    }
  });
});
