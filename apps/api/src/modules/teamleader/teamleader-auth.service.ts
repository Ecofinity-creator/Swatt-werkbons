import type { PrismaClient } from '@prisma/client';
import { getTeamleaderConfig, isTeamleaderConfigured, type TeamleaderEnvConfig } from '../../config/env';
import { TeamleaderErrors } from '../../errors';
import { decryptToken, encryptToken } from './token-crypto.service';

/**
 * OAuth2-eindpunten van Teamleader Focus. Bewust op een apart host
 * (`focus.teamleader.eu`, niet `api.focus.teamleader.eu`) — geverifieerd
 * tegen het officiële, door Teamleader onderhouden API-blueprint
 * (github.com/teamleadercrm/api/blob/master/src/authentication.apib) en
 * developer.focus.teamleader.eu/docs/authentication, en consistent met wat
 * al werkend bevestigd is in het eerdere Ecofinity-Teamleader-traject.
 * Verzin hier NOOIT een endpoint bij — controleer opnieuw tegen die bronnen
 * als hier iets aan moet wijzigen.
 */
const AUTHORIZE_URL = 'https://focus.teamleader.eu/oauth2/authorize';
const TOKEN_URL = 'https://focus.teamleader.eu/oauth2/access_token';

/**
 * Vast, welbekend ID voor de ene TeamleaderConnection-rij die ooit zal
 * bestaan (zie het "singleton"-commentaar bij het model in schema.prisma).
 * Geen betekenis buiten "dit IS de ene rij" — laat toe om altijd via
 * `findUnique`/`upsert` op een vaste sleutel te werken i.p.v. te moeten
 * uitzoeken welke rij "de juiste" is.
 */
export const TEAMLEADER_CONNECTION_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Ververs proactief zodra het access token binnen deze marge verloopt —
 * voorkomt dat een net-nog-geldig token alsnog verloopt tussen het ophalen
 * hier en het effectieve gebruik ervan in een volgende Teamleader-call
 * (vanaf Phase 3: UserSyncService, ProjectSyncService, ...).
 */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface TeamleaderTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export type TeamleaderConnectionStatusValue = 'DISCONNECTED' | 'CONNECTED' | 'ERROR';

export interface TeamleaderConnectionStatusInfo {
  status: TeamleaderConnectionStatusValue;
  connectedAt: Date | null;
  tokenExpiresAt: Date | null;
  lastError: string | null;
}

/** Minimale vorm van de Prisma-rij die deze service nodig heeft — houdt de service zelf test-vriendelijk. */
interface TeamleaderConnectionRow {
  status: TeamleaderConnectionStatusValue;
  accessTokenEncrypted: Uint8Array | null;
  refreshTokenEncrypted: Uint8Array | null;
  tokenExpiresAt: Date | null;
  lastError: string | null;
  connectedAt: Date | null;
}

export class TeamleaderAuthService {
  // In-process lock: voorkomt dat twee gelijktijdige aanvragen voor een
  // geldig access token allebei hun eigen refresh-call naar Teamleader
  // starten (Phase 2-acceptatiecriterium "test op
  // token-refresh-race-condition"). Eén Node-proces volstaat hiervoor in de
  // MVP (zie render.yaml — geen meerdere API-instances); bij horizontale
  // schaling zou dit een DB- of Redis-lock moeten worden.
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  buildAuthorizationUrl(state: string): string {
    const config = this.assertConfigured();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleAuthorizationCallback(params: {
    code: string;
    connectedByUserId: string | null;
  }): Promise<void> {
    const config = this.assertConfigured();
    const tokens = await this.exchangeToken(config, {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: config.redirectUri,
    });
    await this.persistTokens(tokens, params.connectedByUserId);
  }

  async disconnect(): Promise<void> {
    await this.prisma.teamleaderConnection.upsert({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
      create: { id: TEAMLEADER_CONNECTION_SINGLETON_ID, status: 'DISCONNECTED' },
      update: {
        status: 'DISCONNECTED',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        lastError: null,
        connectedAt: null,
        connectedByUserId: null,
      },
    });
  }

  async getStatus(): Promise<TeamleaderConnectionStatusInfo> {
    const connection = await this.findConnection();
    if (!connection) {
      return { status: 'DISCONNECTED', connectedAt: null, tokenExpiresAt: null, lastError: null };
    }
    return {
      status: connection.status,
      connectedAt: connection.connectedAt,
      tokenExpiresAt: connection.tokenExpiresAt,
      lastError: connection.lastError,
    };
  }

  /**
   * Geeft een geldig access token terug voor gebruik door de andere
   * sync-modules (UserSyncService, ProjectSyncService, ... vanaf Phase 3).
   * Ververst het automatisch wanneer het (bijna) verlopen is — "token wordt
   * automatisch ververst vóór verval" (Phase 2-acceptatiecriterium).
   */
  async getValidAccessToken(): Promise<string> {
    this.assertConfigured();
    const connection = await this.findConnection();

    if (!connection || connection.status !== 'CONNECTED' || !connection.refreshTokenEncrypted) {
      throw TeamleaderErrors.notConnected();
    }

    const refreshTokenEncrypted = connection.refreshTokenEncrypted;
    const accessTokenEncrypted = connection.accessTokenEncrypted;
    const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
    const needsRefresh = expiresAt - Date.now() < REFRESH_MARGIN_MS;

    if (!needsRefresh && accessTokenEncrypted) {
      return decryptToken(accessTokenEncrypted);
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken(decryptToken(refreshTokenEncrypted)).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const config = this.assertConfigured();
    let tokens: TeamleaderTokenResponse;

    try {
      tokens = await this.exchangeToken(config, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Onbekende fout bij het vernieuwen van het Teamleader-token.';
      try {
        await this.prisma.teamleaderConnection.update({
          where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
          data: { status: 'ERROR', lastError: message },
        });
      } catch {
        // Best effort — als zelfs deze update faalt, blijft de oorspronkelijke fout leidend.
      }
      throw TeamleaderErrors.reconnectRequired();
    }

    await this.persistTokens(tokens, null);
    return tokens.access_token;
  }

  private async exchangeToken(
    config: TeamleaderEnvConfig,
    params: Record<string, string>,
  ): Promise<TeamleaderTokenResponse> {
    // Body-parameters (niet Basic-auth header) — zo documenteert Teamleader
    // zelf de token-exchange in het officiële apiary-blueprint.
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Teamleader token-endpoint gaf ${response.status} terug: ${errorText || response.statusText}`,
      );
    }

    return (await response.json()) as TeamleaderTokenResponse;
  }

  /**
   * `connectedByUserId === null` betekent hier "dit is een token-refresh,
   * geen nieuwe koppeling" — `connectedAt`/`connectedByUserId` van de
   * bestaande rij blijven dan onaangeroerd. Bij een echte nieuwe koppeling
   * (na de OAuth-callback) geeft de aanroeper altijd de admin-id door.
   */
  private async persistTokens(tokens: TeamleaderTokenResponse, connectedByUserId: string | null): Promise<void> {
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const sharedData = {
      status: 'CONNECTED' as const,
      accessTokenEncrypted: encryptToken(tokens.access_token),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token),
      tokenExpiresAt,
      lastError: null,
    };

    await this.prisma.teamleaderConnection.upsert({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
      create: {
        id: TEAMLEADER_CONNECTION_SINGLETON_ID,
        ...sharedData,
        connectedAt: new Date(),
        connectedByUserId,
      },
      update: {
        ...sharedData,
        ...(connectedByUserId ? { connectedAt: new Date(), connectedByUserId } : {}),
      },
    });
  }

  private async findConnection(): Promise<TeamleaderConnectionRow | null> {
    return this.prisma.teamleaderConnection.findUnique({
      where: { id: TEAMLEADER_CONNECTION_SINGLETON_ID },
    });
  }

  private assertConfigured(): TeamleaderEnvConfig {
    if (!isTeamleaderConfigured()) {
      throw TeamleaderErrors.notConfigured();
    }
    return getTeamleaderConfig();
  }
}
