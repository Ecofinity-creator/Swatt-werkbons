import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeKmAmountCents, DistanceServiceError, OpenRouteServiceDistanceProvider } from '../src/modules/distance/distance.service';

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

describe('computeKmAmountCents()', () => {
  it('berekent heen-en-terug: 12,4 km enkel × €0,35/km → 868 eurocent', () => {
    expect(computeKmAmountCents(12400, 35)).toBe(868); // (12400*2/1000)*35 = 24.8*35 = 868
  });

  it('geeft null zonder gekende afstand', () => {
    expect(computeKmAmountCents(null, 35)).toBeNull();
  });

  it('geeft null zonder ingesteld km-tarief', () => {
    expect(computeKmAmountCents(12400, null)).toBeNull();
  });

  it('rondt af naar de dichtstbijzijnde eurocent', () => {
    expect(computeKmAmountCents(1000, 33)).toBe(66); // (1000*2/1000)*33 = 2*33 = 66, exact
    expect(computeKmAmountCents(1001, 33)).toBe(66); // 2.002*33 = 66.066 -> 66
  });
});
