import type { TeamleaderAuthService } from './teamleader-auth.service';

/**
 * Basis-URL van de eigenlijke Teamleader-REST/RPC-API — bewust een ander host
 * dan de OAuth-endpoints in teamleader-auth.service.ts (`focus.teamleader.eu`).
 * Geverifieerd tegen het officiële blueprint (`HOST: https://api.focus.teamleader.eu`,
 * github.com/teamleadercrm/api/blob/master/apiary.apib).
 */
const API_BASE_URL = 'https://api.focus.teamleader.eu';

/**
 * Teamleader's gedocumenteerde default page-size (zie het `Page`-datatype in
 * het blueprint: `size` default 20). Er staat nergens een hoger toegestaan
 * maximum gedocumenteerd — bewust niet gegokt op een hogere, niet-bevestigde
 * waarde (projectregel: "verzin geen endpoints/parameters"). Dit betekent
 * meer requests bij grote lijsten, wat aanvaardbaar is voor de MVP-omvang.
 */
const DEFAULT_PAGE_SIZE = 20;

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;

export class TeamleaderApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamleaderApiError';
  }
}

/**
 * Dunne, generieke laag bovenop `fetch` voor alle Teamleader REST/RPC-aanroepen
 * (`POST https://api.focus.teamleader.eu/<resource>.<action>`, zie sectie "HTTP
 * RPC-style methods" in het officiële blueprint). Weet zelf niets van OAuth —
 * hergebruikt gewoon `TeamleaderAuthService.getValidAccessToken()` — en niets
 * van een specifiek domein (projecten, klanten, ...); elke sync-service bouwt
 * daar zelf bovenop (zie project-sync.service.ts). Dit is exact de
 * "abstraction/service layer" die de projectbrief vraagt: als een endpoint
 * ooit verandert, verandert enkel de aanroepende service, niet deze laag.
 */
export class TeamleaderClient {
  constructor(private readonly authService: TeamleaderAuthService) {}

  /** Eén enkele RPC-call. Gooit `TeamleaderApiError` op een niet-2xx-antwoord (na eventuele rate-limit-retries). */
  async post<TResponse>(endpoint: string, body: Record<string, unknown> = {}): Promise<TResponse> {
    const accessToken = await this.authService.getValidAccessToken();

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${API_BASE_URL}/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await this.waitForRateLimitReset(response);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new TeamleaderApiError(
          response.status,
          endpoint,
          `${endpoint} gaf ${response.status} terug: ${errorText || response.statusText}`,
        );
      }

      if (response.status === 204) {
        return undefined as TResponse;
      }
      return (await response.json()) as TResponse;
    }
  }

  /**
   * Doorloopt alle pagina's van een `.list`-endpoint (Page-object: `{size, number}`,
   * `data`-array in de response — zie apiary.apib). Stopt zodra een pagina
   * minder dan `size` items teruggeeft (geen aparte "totaal aantal"-call nodig).
   */
  async listAll<TItem>(endpoint: string, baseBody: Record<string, unknown> = {}): Promise<TItem[]> {
    const items: TItem[] = [];
    let pageNumber = 1;

    for (;;) {
      const response = await this.post<{ data: TItem[] }>(endpoint, {
        ...baseBody,
        page: { size: DEFAULT_PAGE_SIZE, number: pageNumber },
      });
      items.push(...response.data);
      if (response.data.length < DEFAULT_PAGE_SIZE) {
        return items;
      }
      pageNumber += 1;
    }
  }

  private async waitForRateLimitReset(response: Response): Promise<void> {
    // `X-RateLimit-Reset` is een absoluut tijdstip (zie apiary.apib, sectie "Rate limiting").
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const resetAtMs = resetHeader ? new Date(resetHeader).getTime() : NaN;
    const waitMs = Number.isFinite(resetAtMs) ? Math.max(0, resetAtMs - Date.now()) + 250 : 2000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS)));
  }
}
