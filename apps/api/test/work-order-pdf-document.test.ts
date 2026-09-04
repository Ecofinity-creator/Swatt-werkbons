import { describe, expect, it } from 'vitest';
import { buildKmCompensation, loadReactPdf } from '../src/modules/work-orders/work-order-pdf-document';
import type { WorkOrderPdfData } from '../src/modules/work-orders/work-order-pdf-document';

/**
 * Op vraag (4/9/2026): "km-vergoeding op de werkbon zelf tonen, niet enkel op
 * de factuur". Test rechtstreeks op de teruggegeven React-elementenboom
 * (i.p.v. een volledige PDF te renderen en de bytes te moeten parsen, waar
 * geen library voor beschikbaar is in dit project) — voldoende om te
 * bewijzen dat de juiste tekst effectief in de boom terechtkomt.
 */

const BASE_DATA: WorkOrderPdfData = {
  workOrderNumber: 'WB-2026-000123',
  customerName: 'Janssens BV',
  projectName: 'Onderhoud warmtepomp',
  projectNumber: 'PRO-1',
  projectAddress: 'Kerkstraat 1, 9000 Gent',
  description: null,
  kmAmountCents: null,
  kmDistanceOneWayMeters: null,
  timeEntries: [],
  photos: [],
  signature: {
    signerName: 'Jan Janssens',
    signerFunction: null,
    signedAt: new Date('2026-08-24T10:00:00Z'),
    image: { data: Buffer.from([]), mimeType: 'image/png' },
  },
  company: {
    companyName: 'Uurivo',
    addressLine: null,
    vatNumber: null,
    contactEmail: null,
    contactPhone: null,
    logo: null,
    legalText: 'De klant bevestigt door ondertekening de hierboven vermelde uitgevoerde werkzaamheden.',
  },
};

/** Doorzoekt de React-elementenboom recursief op alle tekstuele children. */
function collectTexts(node: unknown): string[] {
  if (node == null || typeof node !== 'object') return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  if (typeof children === 'string') return [children];
  if (Array.isArray(children)) return children.flatMap(collectTexts);
  if (children != null && typeof children === 'object') return collectTexts(children);
  return [];
}

describe('buildKmCompensation() — km-vergoeding op de werkbon-PDF', () => {
  it('toont niets wanneer er geen km-vergoeding van toepassing is (kmAmountCents null)', async () => {
    const { View, Text } = await loadReactPdf();
    const element = buildKmCompensation({ View, Text }, BASE_DATA);
    expect(element).toBeNull();
  });

  it('toont niets bij kmAmountCents = 0 (geen zinloze "€ 0,00"-regel)', async () => {
    const { View, Text } = await loadReactPdf();
    const element = buildKmCompensation({ View, Text }, { ...BASE_DATA, kmAmountCents: 0, kmDistanceOneWayMeters: 5000 });
    expect(element).toBeNull();
  });

  it('toont de heen-terug-afstand en het correcte bedrag wanneer een km-vergoeding van toepassing is', async () => {
    const { View, Text } = await loadReactPdf();
    // 12.500m één richting -> 25km heen-terug; bedrag hier een representatief,
    // al elders bevroren getal (via computeKmAmountCents() in distance.service.ts) — deze test controleert enkel de weergave, niet de berekening zelf.
    const element = buildKmCompensation({ View, Text }, { ...BASE_DATA, kmAmountCents: 8750, kmDistanceOneWayMeters: 12_500 });

    expect(element).not.toBeNull();
    const texts = collectTexts(element);
    expect(texts.some((text) => text.includes('25 km heen-terug'))).toBe(true);
    expect(texts.some((text) => text.includes('87,50'))).toBe(true);
  });
});
