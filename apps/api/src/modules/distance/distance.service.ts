/**
 * Phase 12, deel D (sectie 5 van de projectbrief) — "kilometervergoeding via
 * OpenRouteService (gratis tier)". Bewust een dunne interface + één
 * implementatie erachter (`OpenRouteServiceDistanceProvider`), zelfde
 * ontkoppelingspatroon als `TeamleaderClient`/`TeamleaderSyncService`: als de
 * provider later moet wisselen (bv. naar Google Distance Matrix bij hogere
 * volumes), verandert enkel deze ene implementatie, niet de aanroepende code
 * (ProjectSyncService, WorkOrderService).
 *
 * Endpoints geverifieerd via openrouteservice.org-documentatie (30/08/2026):
 * - Geocoding: `GET /geocode/search?api_key=...&text=<adres>` → GeoJSON
 *   FeatureCollection, `features[0].geometry.coordinates` = [lon, lat].
 * - Directions: `GET /v2/directions/driving-car?api_key=...&start=lon,lat&end=lon,lat`
 *   (een eenvoudige GET zonder extra opties geeft GeoJSON terug) →
 *   `features[0].properties.summary.distance` = afstand in meter.
 * Zoals de projectregel voorschrijft ("verzin geen endpoints"): dit is geen
 * aanname maar expliciet nagekeken vóór implementatie — controleer bij twijfel
 * alsnog de interactieve API-documentatie op openrouteservice.org, aangezien
 * dit een extern, door Anthropic niet gehost contract is.
 */

export class DistanceServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistanceServiceError';
  }
}

export interface DistanceService {
  /** Rijafstand in meter, ÉÉN richting, tussen twee vrije-tekst-adressen. Gooit `DistanceServiceError` bij een niet-geocodeerbaar adres of een mislukte routeberekening. */
  getDrivingDistanceMetersOneWay(fromAddress: string, toAddress: string): Promise<number>;
}

const GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

interface GeocodeResponse {
  features: Array<{ geometry: { coordinates: [number, number] } }>;
}

interface DirectionsResponse {
  features: Array<{ properties: { summary: { distance: number } } }>;
}

export class OpenRouteServiceDistanceProvider implements DistanceService {
  constructor(private readonly apiKey: string) {}

  async getDrivingDistanceMetersOneWay(fromAddress: string, toAddress: string): Promise<number> {
    const [from, to] = await Promise.all([this.geocode(fromAddress), this.geocode(toAddress)]);

    const url = new URL(DIRECTIONS_URL);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('start', `${from[0]},${from[1]}`);
    url.searchParams.set('end', `${to[0]},${to[1]}`);

    const response = await this.fetchWithRetry(url, 'rijafstand berekenen');
    const data = (await response.json()) as DirectionsResponse;
    const distance = data.features?.[0]?.properties?.summary?.distance;
    if (typeof distance !== 'number') {
      throw new DistanceServiceError('OpenRouteService gaf geen route terug tussen deze twee adressen.');
    }
    return Math.round(distance);
  }

  private async geocode(address: string): Promise<[number, number]> {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('text', address);
    url.searchParams.set('size', '1');

    const response = await this.fetchWithRetry(url, `adres lokaliseren ("${address}")`);
    const data = (await response.json()) as GeocodeResponse;
    const coordinates = data.features?.[0]?.geometry?.coordinates;
    if (!coordinates) {
      throw new DistanceServiceError(`Kon het adres "${address}" niet lokaliseren.`);
    }
    return coordinates;
  }

  /**
   * Zelfde exponential-backoff-filosofie als TeamleaderClient (sectie 28:
   * "gebruik ... exponential backoff, retries"), hier lokaal gehouden — een
   * gedeelde generieke HTTP-retry-helper zou voor twee losse externe
   * integraties voorlopig meer indirectie toevoegen dan het oplevert.
   */
  private async fetchWithRetry(url: URL, actionDescription: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (err) {
        lastError = err;
        await sleep(Math.min(2 ** attempt * 500, MAX_RATE_LIMIT_WAIT_MS));
        continue;
      }
      if (response.ok) {
        return response;
      }
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterHeader = response.headers.get('retry-after');
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.min(2 ** attempt * 1000, MAX_RATE_LIMIT_WAIT_MS);
        await sleep(waitMs);
        continue;
      }
      throw new DistanceServiceError(`OpenRouteService-fout bij ${actionDescription} (HTTP ${response.status}).`);
    }
    throw new DistanceServiceError(`OpenRouteService niet bereikbaar bij ${actionDescription}: ${String(lastError)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase 12, deel D — km-vergoeding heen-en-terug: `kmDistanceOneWayMeters`
 * is de rijafstand in één richting (zie DistanceService hierboven);
 * vermenigvuldigd met 2 voor heen-terug, omgezet naar kilometer, en
 * vermenigvuldigd met het tarief (eurocent/km). `null` zodra één van beide
 * nog niet gekend is (adres nog niet berekend, of geen km-tarief ingesteld)
 * — een werkbon zonder km-bedrag is dus het normale, niet-foutieve geval
 * zolang de km-vergoeding niet actief is.
 */
export function computeKmAmountCents(kmDistanceOneWayMeters: number | null, kmRateCents: number | null): number | null {
  if (kmDistanceOneWayMeters === null || kmRateCents === null) return null;
  const roundTripKm = (kmDistanceOneWayMeters * 2) / 1000;
  return Math.round(roundTripKm * kmRateCents);
}
