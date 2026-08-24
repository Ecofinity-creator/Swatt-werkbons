import { describe, expect, it, vi } from 'vitest';
import { TeamleaderUserService } from '../src/modules/teamleader/teamleader-user.service';
import { TeamleaderApiError, type TeamleaderClient } from '../src/modules/teamleader/teamleader-client.service';

/**
 * Unit-tests met een fake TeamleaderClient (post/listAll rechtstreeks gemockt
 * — geen fetch nodig, zie teamleader-client.service.ts) i.p.v. een fake fetch,
 * exact zoals de andere Phase 9-services hieronder getest worden.
 */
function fakeClient(listAllImpl: (...args: unknown[]) => Promise<unknown>): TeamleaderClient {
  return {
    post: vi.fn(),
    listAll: vi.fn(listAllImpl),
  } as unknown as TeamleaderClient;
}

describe('TeamleaderUserService', () => {
  it('geeft actieve gebruikers terug, gesorteerd op weergavenaam', async () => {
    const client = fakeClient(async () => [
      { id: '2', first_name: 'Wannes', last_name: 'Vermeersch', email: 'wannes@ecofinity.eu', status: 'active' },
      { id: '1', first_name: 'Peter', last_name: 'Janssens', email: 'peter@ecofinity.eu', status: 'active' },
    ]);
    const service = new TeamleaderUserService(client);

    const users = await service.listActiveUsers();

    expect(users).toEqual([
      { id: '1', displayName: 'Peter Janssens' },
      { id: '2', displayName: 'Wannes Vermeersch' },
    ]);
  });

  it('valt terug op het e-mailadres wanneer voor- en achternaam leeg zijn', async () => {
    const client = fakeClient(async () => [{ id: '3', first_name: '', last_name: '', email: 'info@ecofinity.eu', status: 'active' }]);
    const service = new TeamleaderUserService(client);

    const users = await service.listActiveUsers();

    expect(users).toEqual([{ id: '3', displayName: 'info@ecofinity.eu' }]);
  });

  it('vertaalt een TeamleaderApiError naar een mensentaal-foutmelding', async () => {
    const client = fakeClient(async () => {
      throw new TeamleaderApiError(500, 'users.list', 'users.list gaf 500 terug');
    });
    const service = new TeamleaderUserService(client);

    await expect(service.listActiveUsers()).rejects.toMatchObject({ code: 'TEAMLEADER_SYNC_FAILED' });
  });
});
