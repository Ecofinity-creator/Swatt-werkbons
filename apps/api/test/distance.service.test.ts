import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeKmAmountCents, DistanceServiceError, HereDistanceProvider, OpenRouteServiceDistanceProvider } from '../src/modules/distance/distance.service';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const GEOCODE_SWATT = { features: [{ geometry: { coordinates: [4.4, 51.2] } }] };
const GEOCODE_CUSTOMER = { features: [{ geometry: { coordinates: [4.5, 51.3] } }] };
const DIRECTIONS_12KM = { features: [{ properties: { summary: { distance: 12345.6 } } }] };

describe('OpenRouteServiceDistanceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('geocodeert beide adressen en berekent de rijafstand in meter, afgerond', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_SWATT))
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_CUSTOMER))
      .mockResolvedValueOnce(jsonResponse(200, DIRECTIONS_12KM));

    const provider = new OpenRouteServiceDistanceProvider('test-key');
    const meters = await provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres');

    expect(meters).toBe(12346); // afgerond
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const geocodeCall = fetchMock.mock.calls[0]![0] as URL;
    expect(geocodeCall.toString()).toContain('geocode/search');
    expect(geocodeCall.searchParams.get('text')).toBe('Swatt-adres');
    const directionsCall = fetchMock.mock.calls[2]![0] as URL;
    expect(directionsCall.toString()).toContain('v2/directions/driving-car');
    expect(directionsCall.searchParams.get('start')).toBe('4.4,51.2');
    expect(directionsCall.searchParams.get('end')).toBe('4.5,51.3');
  });

  it('gooit een duidelijke fout wanneer een adres niet geocodeerbaar is', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { features: [] }));

    const provider = new OpenRouteServiceDistanceProvider('test-key');
    await expect(provider.getDrivingDistanceMetersOneWay('Onbestaand adres', 'Klantadres')).rejects.toThrow(DistanceServiceError);
  });

  it('herprobeert bij HTTP 429 (rate limit) en slaagt bij de volgende poging', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_SWATT))
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_CUSTOMER))
      .mockResolvedValueOnce(jsonResponse(200, DIRECTIONS_12KM));

    const provider = new OpenRouteServiceDistanceProvider('test-key');
    const meters = await provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres');

    expect(meters).toBe(12346);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 mislukte + 3 geslaagde
  });

  it('gooit een duidelijke fout bij een blijvende serverfout (geen 429)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    const provider = new OpenRouteServiceDistanceProvider('test-key');
    await expect(provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres')).rejects.toThrow(DistanceServiceError);
  });
  it('geeft geen route terug: duidelijke fout i.p.v. NaN/undefined te laten doorsijpelen', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_SWATT))
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_CUSTOMER))
      .mockResolvedValueOnce(jsonResponse(200, { features: [] }));

    const provider = new OpenRouteServiceDistanceProvider('test-key');
    await expect(provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres')).rejects.toThrow(DistanceServiceError);
  });
});

describe('HereDistanceProvider (op vraag 7/9/2026, na een langdurige OpenRouteService-storing)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const GEOCODE_SWATT = { items: [{ position: { lat: 51.2, lng: 4.4 } }] };
  const GEOCODE_CUSTOMER = { items: [{ position: { lat: 51.3, lng: 4.5 } }] };
  const ROUTE_12KM = { routes: [{ sections: [{ summary: { length: 12345.6 } }] }] };

  it('geocodeert beide adressen en berekent de rijafstand in meter, afgerond', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_SWATT))
      .mockResolvedValueOnce(jsonResponse(200, GEOCODE_CUSTOMER))
      .mockResolvedValueOnce(jsonResponse(200, ROUTE_12KM));

    const provider = new HereDistanceProvider('test-key');
    const meters = await provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres');

    expect(meters).toBe(12346); // afgerond
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const geocodeCall = fetchMock.mock.calls[0]![0] as URL;
    expect(geocodeCall.toString()).toContain('geocode.search.hereapi.com/v1/geocode');
    expect(geocodeCall.searchParams.get('q')).toBe('Swatt-adres');
    const routingCall = fetchMock.mock.calls[2]![0] as URL;
    expect(routingCall.toString()).toContain('router.hereapi.com/v8/routes');
    expect(routingCall.searchParams.get('origin')).toBe('51.2,4.4');
    expect(routingCall.searchParams.get('destination')).toBe('51.3,4.5');
    expect(routingCall.searchParams.get('transportMode')).toBe('car');
  });

  it('gooit een duidelijke fout wanneer een adres niet geocodeerbaar is', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));

    const provider = new HereDistanceProvider('test-key');
    await expect(provider.getDrivingDistanceMetersOneWay('Onbestaand adres', 'Klantadres')).rejects.toThrow(DistanceServiceError);
  });

  it('gooit een duidelijke fout bij een blijvende serverfout (geen 429) — bv. het HTTP 403 dat OpenRouteService liet crashen', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Invalid API key or access to this API has been disallowed' }));

    const provider = new HereDistanceProvider('test-key');
    await expect(provider.getDrivingDistanceMetersOneWay('Swatt-adres', 'Klantadres')).rejects.toThrow(DistanceServiceError);
  });
});

describe('computeKmAmountCents() (klantvraag 10/9/2026 — getrapte prijs per project)', () => {
  const DEFAULT_PRICING = { flatFeeThresholdKm: 65, flatFeeCents: 3500, rateAboveCentsPerKm: 80 };

  it('binnen de drempel: enkel de vaste prijs, ongeacht de exacte afstand', () => {
    // 12,4 km enkel = 24,8 km heen-terug, ruim onder de drempel van 65 km.
    expect(computeKmAmountCents(12400, DEFAULT_PRICING)).toBe(3500);
  });

  it('exact op de drempel: nog steeds enkel de vaste prijs', () => {
    // 32,5 km enkel = 65 km heen-terug, exact de drempel.
    expect(computeKmAmountCents(32500, DEFAULT_PRICING)).toBe(3500);
  });

  it('boven de drempel: vaste prijs + tarief per extra km', () => {
    // 40 km enkel = 80 km heen-terug = 15 km boven de drempel van 65.
    // 3500 + 15*80 = 3500 + 1200 = 4700.
    expect(computeKmAmountCents(40000, DEFAULT_PRICING)).toBe(4700);
  });

  it('geeft null zonder gekende afstand', () => {
    expect(computeKmAmountCents(null, DEFAULT_PRICING)).toBeNull();
  });

  it('geeft null wanneer de vaste prijs niet ingesteld is (km-vergoeding niet actief voor dit project)', () => {
    expect(computeKmAmountCents(40000, { ...DEFAULT_PRICING, flatFeeCents: null })).toBeNull();
  });

  it('rondt het extra-km-bedrag af naar de dichtstbijzijnde eurocent', () => {
    // 50,05 km enkel = 100,1 km heen-terug = 35,1 km boven de drempel van 65.
    // 3500 + 35,1*80 = 3500 + 2808 = 6308 (exact), en licht verschoven om afronding te forceren:
    expect(computeKmAmountCents(50051, DEFAULT_PRICING)).toBe(6308); // 35,102*80 = 2808,16 -> 6308,16 -> 6308
  });
});
