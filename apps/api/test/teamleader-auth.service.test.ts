import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TeamleaderAuthService,
} from '../src/modules/teamleader/teamleader-auth.service';

/**
 * Unit-tests met een minimale fake-Prisma (geen echte database/gegenereerde
 * client nodig — `PrismaClient` wordt in teamleader-auth.service.ts enkel als
 * `import type` gebruikt) en een gemockte `fetch` (nooit een echte
 * netwerkcall naar Teamleader). Test dus enkel het "geconfigureerd"-pad.
 *
 * Vereist dat TEAMLEADER_CLIENT_ID / TEAMLEADER_CLIENT_SECRET /
 * TEAMLEADER_REDIRECT_URI / TEAMLEADER_TOKEN_ENCRYPTION_KEY gezet zijn (zie
 * README "Tests draaien"). Het "niet geconfigureerd"-pad zit apart in
 * teamleader-not-configured.test.ts, met een eigen module-mock — onafhankelijk
 * van deze omgevingsvariabelen.
 */

interface FakeRow {
  id: string;
  status: 'DISCONNECTED' | 'CONNECTED' | 'ERROR';
  accessTokenEncrypted: Buffer | null;
  refreshTokenEncrypted: Buffer | null;
  tokenExpiresAt: Date | null;
  lastError: string | null;
  connectedAt: Date | null;
  connectedByUserId: string | null;
}

function createFakePrisma() {
  let row: FakeRow | null = null;

  const teamleaderConnection = {
    findUnique: vi.fn(async () => row),
    upsert: vi.fn(async ({ create, update }: { create: FakeRow; update: Partial<FakeRow> }) => {
      row = row ? { ...row, ...update } : { ...create };
      return row;
    }),
    update: vi.fn(async ({ data }: { data: Partial<FakeRow> }) => {
      if (!row) throw new Error('geen rij om te updaten in de fake-Prisma');
      row = { ...row, ...data };
      return row;
    }),
  };

  return {
    prisma: { teamleaderConnection } as unknown as PrismaClient,
    getRow: () => row,
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('TeamleaderAuthService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bouwt een correcte authorize-URL met client_id, redirect_uri en state', () => {
    const { prisma } = createFakePrisma();
    const service = new TeamleaderAuthService(prisma);

    const url = new URL(service.buildAuthorizationUrl('mijn-state-123'));

    expect(url.origin + url.pathname).toBe('https://focus.teamleader.eu/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('mijn-state-123');
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBeTruthy();
  });

  it('wisselt een autorisatiecode in voor tokens en bewaart ze versleuteld (nooit in platte tekst)', async () => {
    const { prisma, getRow } = createFakePrisma();
    const service = new TeamleaderAuthService(prisma);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'plain-access-token',
        refresh_token: 'plain-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );

    await service.handleAuthorizationCallback({ code: 'auth-code-abc', connectedByUserId: 'user-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('https://focus.teamleader.eu/oauth2/access_token');
    expect(String(calledInit.body)).toContain('grant_type=authorization_code');
    expect(String(calledInit.body)).toContain('code=auth-code-abc');

    const row = getRow();
    expect(row?.status).toBe('CONNECTED');
    expect(row?.connectedByUserId).toBe('user-1');
    expect(row?.accessTokenEncrypted?.toString('utf8')).not.toContain('plain-access-token');

    const status = await service.getStatus();
    expect(status.status).toBe('CONNECTED');
  });

  it('geeft TEAMLEADER_NOT_CONNECTED terug wanneer er nog geen koppeling is', async () =>
