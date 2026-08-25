import type { PrismaClient } from '@prisma/client';
import { TeamleaderErrors } from '../../errors';
import type { StorageService } from '../storage/storage.service';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';
import type { SyncResult } from './time-tracking-sync.service';

interface FilesUploadResponse {
  data: { location: string; expires_at: string };
}

interface FilesListRow {
  id: string;
  name: string;
  updated_at: string;
}

const WITH_PROJECT = { include: { project: true } } as const;

/**
 * Phase 9 — sectie 13/31: upload van de (Phase 8-)PDF naar het gekoppelde
 * Teamleader-project. Twee stappen, exact zoals gedocumenteerd in het
 * officiële blueprint (apiary.apib, sectie "Files"):
 *   1. `files.upload` vraagt een kortlevende upload-URL (`location`) aan.
 *   2. De eigenlijke bestandsbytes gaan via een aparte POST naar die URL.
 *
 * BELANGRIJK — stap 2 is in het officiële blueprint NIET verder
 * gespecificeerd dan "a temporary API endpoint (URL) where user should send
 * a POST request with file contents for the upload". Wij implementeren dit
 * als een standaard `multipart/form-data`-POST met het bestand onder
 * veldnaam `file` — het gangbare patroon voor dit soort "vraag eerst een
 * upload-URL aan"-APIs (vergelijkbaar met S3 presigned posts). Dit is NIET
 * live geverifieerd tegen een echt Teamleader-account (geen OAuth-verbinding
 * in deze sandbox) — bij een afwijzing loggen we de volledige responstekst
 * (zie postFileBytes hieronder) zodat dit snel bijgesteld kan worden op basis
 * van de échte foutmelding.
 *
 * Het antwoord van stap 2 is evenmin gedocumenteerd (dus onbekend of het
 * meteen het nieuwe `file.id` teruggeeft) — we proberen het uit de JSON-
 * respons te lezen, en vallen anders terug op een `files.list`-opvraging
 * (meest recente bestand met dezelfde naam op dit project) om toch business
 * rule 6 ("hoogstens één actieve Teamleader-file per werkbon") te kunnen
 * afdwingen bij een volgende reupload.
 *
 * Legacy vs. `nextgenProject` als subject: `nextgenProject` is expliciet
 * gedocumenteerd voor `files.upload`. Legacy `project` komt wél voor in
 * `files.info`'s subject-enum maar ontbrak in de huidige weergave van
 * `files.upload`'s enum in het blueprint — vermoedelijk een documentatie-
 * omissie (het bestond al vóór `nextgenProject` werd toegevoegd, zie de
 * changelog-entry "We added `nextgenProject` as a subject type to
 * `files.upload`..."). Swatt/Ecofinity's account is legacy; deze aanname is
 * dus wél de praktisch relevante voor deze app, maar nog niet live bevestigd.
 */
export class FileSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: TeamleaderClient,
    private readonly storage: StorageService,
  ) {}

  async uploadPdf(workOrderId: string): Promise<SyncResult> {
    const workOrder = await this.prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId }, ...WITH_PROJECT });

    if (workOrder.pdfStatus !== 'PDF_READY' || !workOrder.pdfFileKey) {
      // Kan in de praktijk niet voorkomen (SyncJobService plant deze job pas
      // ná een geslaagde /sign, die de PDF synchroon genereert) — defensief
      // afgehandeld als een gewone mislukking i.p.v. te crashen.
      const message = 'De PDF van deze werkbon is nog niet beschikbaar om te uploaden.';
      await this.markFailed(workOrderId, message);
      return { success: false, message };
    }

    const subjectType = workOrder.project.teamleaderModule === 'PROJECTS_V2' ? 'nextgenProject' : 'project';
    const fileName = workOrder.pdfFileName ?? `${workOrder.workOrderNumber}.pdf`;

    try {
      const file = await this.storage.read(workOrder.pdfFileKey);

      const uploadRequest = await this.client.post<FilesUploadResponse>('files.upload', {
        name: fileName,
        subject: { type: subjectType, id: workOrder.project.teamleaderId },
        folder: 'Werkbonnen',
      });

      let teamleaderFileId = await this.postFileBytes(uploadRequest.data.location, file.data, file.mimeType);
      if (!teamleaderFileId) {
        teamleaderFileId = await this.findUploadedFileId(subjectType, workOrder.project.teamleaderId, fileName);
      }

      // Business rule 6: hoogstens één actieve Teamleader-file per werkbon —
      // het vorige bestand (bv. na "PDF opnieuw genereren" + reupload)
      // best-effort verwijderen. Nooit laten falen op een verwijderfout: het
      // nieuwe bestand staat al veilig in Teamleader.
      if (workOrder.teamleaderFileId && workOrder.teamleaderFileId !== teamleaderFileId) {
        try {
          await this.client.post('files.delete', { id: workOrder.teamleaderFileId });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[FileSyncService] Kon vorig Teamleader-bestand ${workOrder.teamleaderFileId} niet verwijderen`, err);
        }
      }

      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          teamleaderUploadStatus: 'TEAMLEADER_UPLOADED',
          teamleaderFileId,
          teamleaderUploadedAt: new Date(),
          teamleaderUploadError: null,
        },
      });
      return { success: true, message: null };
    } catch (err) {
      const message =
        err instanceof TeamleaderApiError
          ? TeamleaderErrors.syncFailed(err.message).message
          : err instanceof Error
            ? TeamleaderErrors.syncFailed(err.message).message
            : TeamleaderErrors.syncFailed('onbekende fout').message;
      await this.markFailed(workOrderId, message);
      return { success: false, message };
    }
  }

  private async markFailed(workOrderId: string, message: string): Promise<void> {
    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { teamleaderUploadStatus: 'TEAMLEADER_UPLOAD_FAILED', teamleaderUploadError: message },
    });
  }

  /**
   * Zie de uitgebreide toelichting bovenaan dit bestand — stap 2 van
   * files.upload, niet verder gespecificeerd in het officiële blueprint
   * ("a POST request with file contents" — geen woord over multipart/
   * form-data of een specifieke veldnaam). Een eerdere `multipart/form-data`-
   * poging (S3-presigned-post-stijl) gaf live een lege 400 terug (geen enkele
   * foutdetail in de responstekst) — vermoedelijk wijst een tussenlaag die
   * vorm meteen af vóór er ooit een nette JSON-foutmelding opgebouwd wordt.
   * Dit probeert nu de ruwe bestandsbytes rechtstreeks als POST-body, met
   * het echte MIME-type als Content-Type — het andere gangbare patroon voor
   * dit soort "tijdelijke upload-URL"-API's. Nog steeds niet live bevestigd;
   * bij een volgende afwijzing loggen/tonen we opnieuw de volledige respons.
   */
  private async postFileBytes(location: string, data: Buffer, mimeType: string): Promise<string | null> {
    const response = await fetch(location, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: data,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // eslint-disable-next-line no-console -- bewust: dit is precies de plek waar de volledige responstekst nodig is om de nog-niet-live-geverifieerde stap 2 hierboven te diagnosticeren/bij te stellen.
      console.error(`[FileSyncService] Bestandsupload naar Teamleader gaf ${response.status} terug: ${text}`);
      // Tot voor kort ging deze responstekst ENKEL naar de server-log (niet
      // rechtstreeks bekeken zonder Render-toegang) — de gebruiker zag enkel
      // "bestandsupload gaf 400 terug" zonder verdere info, onbruikbaar om
      // deze nog-niet-live-geverifieerde stap te diagnosticeren. Nu ook in de
      // foutmelding zelf (zoals TeamleaderClient.post() dat al deed voor stap
      // 1) — afgekapt op 500 tekens, voor het geval het een grote HTML-
      // foutpagina is i.p.v. een korte JSON-foutmelding.
      const truncatedText = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      throw new TeamleaderApiError(
        response.status,
        'files.upload (stap 2)',
        `bestandsupload gaf ${response.status} terug${truncatedText ? `: ${truncatedText}` : ''}`,
      );
    }
    try {
      const body = (await response.json()) as { data?: { id?: string } };
      return body.data?.id ?? null;
    } catch {
      return null; // Geen (geldige) JSON-respons — geen probleem, zie findUploadedFileId hieronder als fallback.
    }
  }

  /** Fallback wanneer stap 2 geen bruikbaar file-ID teruggaf — zoekt het zonet geüploade bestand terug via `files.list`. */
  private async findUploadedFileId(subjectType: 'project' | 'nextgenProject', subjectId: string, fileName: string): Promise<string | null> {
    try {
      const rows = await this.client.listAll<FilesListRow>('files.list', {
        filter: { subject: { type: subjectType, id: subjectId } },
      });
      const matches = rows.filter((row) => row.name === fileName).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return matches[0]?.id ?? null;
    } catch {
      return null;
    }
  }
}
