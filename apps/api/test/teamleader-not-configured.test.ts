import { describe, expect, it, vi } from 'vitest';

/**
 * Apart bestand (i.p.v. een test binnen teamleader-auth.service.test.ts):
 * Vitest isoleert de module-registry per testbestand, dus deze `vi.mock` van
 * config/env kan hier veilig de "niet geconfigureerd"-toestand simuleren
 * zonder de rest van de suite te beïnvloeden — en zonder zelf afhankelijk te
 * zijn van of TEAMLEADER_* in de omgeving gezet is.
 *
 * `vi.mock(...)`-aanroepen worden door Vitest naar de top van het bestand
 * gehesen (vóór alle imports), dus de volgorde hieronder — mock vóór de
 * statische import van TeamleaderAuthService — is het standaard, bewust zo
 * gedocumenteerde Vitest-patroon (en vermijdt een dynamische `import()`,
 * die onder deze tsconfig — module: Node16 — een expliciete
 * bestandsextensie zou vereisen).
 */
vi.mock('../src/config/env', () => ({
  isTeamleaderConfigured: () => false,
  getTeamleaderConfig: () => {
    throw new Error('getTeamleaderConfig() aangeroepen terwijl niet geconfigureerd — test-mock');
  },
  env: { CORS_ORIGINS: ['http://localhost:5173'], COOKIE_SECURE: false },
}));

import { TeamleaderAuthService } from '../src/modules/teamleader/teamleader-auth.service';

describe('TeamleaderAuthService — Teamleader-integratie niet geconfigureerd', () => {
  it('gooit een duidelijke TEAMLEADER_NOT_CONFIGURED-fout i.p.v. een kale crash', () => {
    const fakePrisma = { teamleaderConnection: {} } as never;
    const service = new TeamleaderAuthService(fakePrisma);

    expect(() => service.buildAuthorizationUrl('state-123')).toThrowError(
      expect.objectContaining({ code: 'TEAMLEADER_NOT_CONFIGURED', statusCode: 503 }),
    );
  });
});
