import { TeamleaderErrors } from '../../errors';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

interface TeamleaderUserRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  status: 'active' | 'deactivated';
}

export interface TeamleaderUserOption {
  id: string;
  displayName: string;
}

/**
 * Phase 9 — live opvraging van Teamleader-gebruikers (`users.list`, sectie
 * "Users" in het officiële blueprint), zodat een admin een medewerker aan de
 * juiste Teamleader-gebruiker kan koppelen. Nodig voor twee dingen:
 * - `timeTracking.add`'s `user_id` (sectie 14): "To add tracked time for a
 *   different user" — zonder koppeling zou elke registratie op naam van de
 *   koppelende integratie-gebruiker komen te staan i.p.v. de echte technieker.
 * - `milestones.create`'s verplichte `responsible_user_id` bij automatische
 *   milestone-aanmaak (zie MilestoneSyncService).
 *
 * Bewust GEEN lokale cache/tabel (in tegenstelling tot ProjectSyncService):
 * een gebruikerslijst is klein en verandert zelden, dus een lichte live-
 * aanroep bij het openen van het koppelingsscherm is eenvoudiger dan een
 * aparte UserSyncService + synctabel — die zou pas de moeite waard zijn bij
 * een grotere/snel wijzigende gebruikerslijst dan wat een KMO als Swatt heeft.
 */
export class TeamleaderUserService {
  constructor(private readonly client: TeamleaderClient) {}

  async listActiveUsers(): Promise<TeamleaderUserOption[]> {
    let rows: TeamleaderUserRow[];
    try {
      rows = await this.client.listAll<TeamleaderUserRow>('users.list', { filter: { status: ['active'] } });
    } catch (err) {
      throw err instanceof TeamleaderApiError ? TeamleaderErrors.syncFailed(err.message) : err;
    }

    return rows
      .map((row) => ({
        id: row.id,
        displayName: `${row.first_name} ${row.last_name}`.trim() || row.email,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
