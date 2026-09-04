import type { PendingWeekEntrySummary, WorkOrderPhotoCategory, WorkOrderSummary } from '@swatt/shared-types';
import {
  roleAtLeast,
  WORK_ORDER_PHOTO_CATEGORY_LABELS,
  WORK_ORDER_PDF_STATUS_LABELS,
  WORK_ORDER_TEAMLEADER_UPLOAD_STATUS_LABELS,
  WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS,
} from '@swatt/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { weeklyApprovalApi, workOrderPhotosApi, workOrdersApi } from '../api/client';
import { ApiRequestError, useAuth } from '../auth/AuthContext';
import { SignatureCanvas, type SignatureCanvasHandle } from '../components/SignatureCanvas';
import { compressImageFile } from '../lib/image';

/**
 * Phase 6/7 — werkbon afwerken: foto's toevoegen en laten ondertekenen door
 * de klant (secties 9-10 van de projectbrief). Bereikbaar vanaf
 * ProjectTimerPage meteen na het stoppen van de timer ("Werkbon afwerken →"),
 * maar ook rechtstreeks navigeerbaar (bv. vanuit een werkbonnenoverzicht in
 * een latere fase) — vandaar dat deze pagina zelf de volledige werkbon ophaalt
 * i.p.v. enkel op router-state te vertrouwen.
 *
 * Een niet-DRAFT werkbon (SIGNED en verder) is immutable (business rule 3) —
 * deze pagina toont die dan enkel read-only, zonder foto-/onderteken-UI.
 */
export function WorkOrderReviewPage() {
  const { workOrderId } = useParams<{ workOrderId: string }>();
  const { user } = useAuth();

  const [workOrder, setWorkOrder] = useState<WorkOrderSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [step, setStep] = useState<'review' | 'sign'>('review');

  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [category, setCategory] = useState<WorkOrderPhotoCategory | ''>('');
  const [removingPhotoId, setRemovingPhotoId] = useState<string | null>(null);

  const [signerName, setSignerName] = useState('');
  const [signerFunction, setSignerFunction] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [signatureIsEmpty, setSignatureIsEmpty] = useState(true);
  const signatureRef = useRef<SignatureCanvasHandle>(null);

  const [isRegeneratingPdf, setIsRegeneratingPdf] = useState(false);
  const [regeneratePdfError, setRegeneratePdfError] = useState<string | null>(null);

  // Op vraag (3/9/2026): "PDF via een knop naar de klant sturen".
  const [isSendingToCustomer, setIsSendingToCustomer] = useState(false);
  const [sendToCustomerError, setSendToCustomerError] = useState<string | null>(null);
  const [sendToCustomerSentAt, setSendToCustomerSentAt] = useState<string | null>(null);

  const [isRetryingSync, setIsRetryingSync] = useState(false);
  const [retrySyncError, setRetrySyncError] = useState<string | null>(null);

  // Phase 12, deel B (sectie 2) — enkel relevant wanneer workOrder.projectSigningMode === 'WEEKLY'.
  const [pendingWeekCount, setPendingWeekCount] = useState<number | null>(null);
  // Op vraag (2/9/2026): "alle tijden tonen zodat de ondertekenaar ziet wat hij goedkeurt".
  const [pendingWeekEntries, setPendingWeekEntries] = useState<PendingWeekEntrySummary[] | null>(null);

  const load = useCallback(async () => {
    if (!workOrderId) return;
    try {
      const response = await workOrdersApi.get(workOrderId);
      setWorkOrder(response.workOrder);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de werkbon niet ophalen.');
    } finally {
      setIsLoading(false);
    }
  }, [workOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Phase 12, deel B — zodra de werknemer de ondertekenstap bereikt op een
  // WEEKLY-project, tonen we hoeveel werkbonnen deze week in totaal mee
  // getekend zullen worden (niet enkel deze ene) — dit voorkomt de verrassing
  // dat één handtekening plots meerdere werkbonnen tegelijk afsluit.
  useEffect(() => {
    if (step !== 'sign' || !workOrder || workOrder.projectSigningMode !== 'WEEKLY') {
      setPendingWeekCount(null);
      setPendingWeekEntries(null);
      return;
    }
    weeklyApprovalApi
      .pendingWeek(workOrder.projectId)
      .then((response) => {
        setPendingWeekCount(response.workOrderIds.length);
        setPendingWeekEntries(response.entries);
      })
      .catch(() => {
        setPendingWeekCount(null);
        setPendingWeekEntries(null);
      });
  }, [step, workOrder]);

  if (!workOrderId) {
    return null;
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0 || !workOrderId) return;
    setUploadError(null);
    setIsUploadingPhoto(true);
    try {
      for (const file of Array.from(files)) {
        const compressed = await compressImageFile(file);
        const response = await workOrderPhotosApi.add(workOrderId, {
          category: category || null,
          optimizedMimeType: compressed.optimizedMimeType,
          optimizedDataBase64: compressed.optimizedDataBase64,
          thumbnailMimeType: compressed.thumbnailMimeType,
          thumbnailDataBase64: compressed.thumbnailDataBase64,
        });
        setWorkOrder(response.workOrder);
      }
    } catch (err) {
      setUploadError(err instanceof ApiRequestError ? err.message : 'Kon de foto niet toevoegen.');
    } finally {
      setIsUploadingPhoto(false);
    }
  }

  async function handleRemovePhoto(photoId: string) {
    if (!workOrderId) return;
    setUploadError(null);
    setRemovingPhotoId(photoId);
    try {
      const response = await workOrderPhotosApi.remove(workOrderId, photoId);
      setWorkOrder(response.workOrder);
    } catch (err) {
      setUploadError(err instanceof ApiRequestError ? err.message : 'Kon de foto niet verwijderen.');
    } finally {
      setRemovingPhotoId(null);
    }
  }

  async function handleSign() {
    if (!workOrderId || !workOrder) return;
    const trimmedName = signerName.trim();
    if (!trimmedName || !confirmed || signatureRef.current?.isEmpty()) {
      setSignError('Vul de naam van de klant in, bevestig de werkzaamheden en teken hieronder.');
      return;
    }
    const dataUrl = signatureRef.current?.toDataUrl();
    if (!dataUrl) {
      setSignError('Teken eerst hieronder voor je bevestigt.');
      return;
    }
    setSignError(null);
    setIsSigning(true);
    try {
      const trimmedFunction = signerFunction.trim();
      const signBody = {
        signerName: trimmedName,
        ...(trimmedFunction ? { signerFunction: trimmedFunction } : {}),
        confirmed: true as const,
        mimeType: 'image/png' as const,
        signatureDataBase64: stripDataUrlPrefix(dataUrl),
      };

      if (workOrder.projectSigningMode === 'WEEKLY') {
        // Sectie 2 — één handtekening tekent de hele lopende week op dit
        // project in één keer (WeeklyApprovalService.signCurrentWeek()),
        // niet enkel deze ene werkbon.
        await weeklyApprovalApi.signWeek(workOrder.projectId, signBody);
        const response = await workOrdersApi.get(workOrderId);
        setWorkOrder(response.workOrder);
      } else {
        const response = await workOrdersApi.sign(workOrderId, signBody);
        setWorkOrder(response.workOrder);
      }
    } catch (err) {
      setSignError(err instanceof ApiRequestError ? err.message : 'Kon de handtekening niet opslaan.');
    } finally {
      setIsSigning(false);
    }
  }

  async function handleRegeneratePdf() {
    if (!workOrderId) return;
    setRegeneratePdfError(null);
    setIsRegeneratingPdf(true);
    try {
      const response = await workOrdersApi.regeneratePdf(workOrderId);
      setWorkOrder(response.workOrder);
    } catch (err) {
      setRegeneratePdfError(err instanceof ApiRequestError ? err.message : 'Kon de PDF niet opnieuw genereren.');
    } finally {
      setIsRegeneratingPdf(false);
    }
  }

  /** Op vraag (3/9/2026): "PDF via een knop naar de klant sturen". */
  async function handleSendToCustomer() {
    if (!workOrderId) return;
    setSendToCustomerError(null);
    setIsSendingToCustomer(true);
    try {
      const response = await workOrdersApi.sendToCustomer(workOrderId);
      setSendToCustomerSentAt(response.sentAt);
    } catch (err) {
      setSendToCustomerError(err instanceof ApiRequestError ? err.message : 'Versturen naar de klant is mislukt.');
    } finally {
      setIsSendingToCustomer(false);
    }
  }

  /**
   * Phase 9 — sectie 13: handmatige "Opnieuw synchroniseren" (SUPERVISOR+,
   * zie SyncJobService.retry).
   *
   * BELANGRIJK: de `retrySync`-aanroep zet de synctaken enkel op de wachtrij
   * en wácht niet op het echte Teamleader-resultaat — dat gebeurt
   * asynchroon door de (inline of aparte) worker, meestal binnen enkele
   * seconden. Het antwoord van `retrySync` zelf toont daardoor nog de
   * VORIGE foutmelding, wat verwarrend overkwam als "hij probeert niet eens
   * opnieuw" (live vastgesteld: de knop gaf ogenschijnlijk meteen dezelfde
   * fout terug). We pollen hierna een aantal keer tot beide syncstatussen
   * niet meer PENDING zijn, zodat de gebruiker het échte resultaat ziet
   * zonder zelf handmatig te moeten verversen.
   */
  async function handleRetrySync() {
    if (!workOrderId) return;
    setRetrySyncError(null);
    setIsRetryingSync(true);
    try {
      await workOrdersApi.retrySync(workOrderId);

      const MAX_ATTEMPTS = 8;
      const POLL_DELAY_MS = 2000;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
        const response = await workOrdersApi.get(workOrderId);
        setWorkOrder(response.workOrder);

        const timeSettled = response.workOrder.timeTrackingSyncStatus !== 'PENDING';
        const uploadSettled = response.workOrder.teamleaderUploadStatus !== 'TEAMLEADER_UPLOAD_PENDING';
        if (timeSettled && uploadSettled) break;
      }
    } catch (err) {
      setRetrySyncError(err instanceof ApiRequestError ? err.message : 'Opnieuw synchroniseren is mislukt.');
    } finally {
      setIsRetryingSync(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Werkbon</p>
        <Link to="/mijn-projecten" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </p>
      )}

      {isLoading && !errorMessage && <p className="text-neutral-400">Laden...</p>}

      {!isLoading && workOrder && workOrder.status !== 'DRAFT' && (
        <SignedWorkOrderView
          workOrder={workOrder}
          canManagePdf={user != null && roleAtLeast(user.role, 'SUPERVISOR')}
          isRegeneratingPdf={isRegeneratingPdf}
          regeneratePdfError={regeneratePdfError}
          onRegeneratePdf={() => void handleRegeneratePdf()}
          isSendingToCustomer={isSendingToCustomer}
          sendToCustomerError={sendToCustomerError}
          sendToCustomerSentAt={sendToCustomerSentAt}
          onSendToCustomer={() => void handleSendToCustomer()}
          isRetryingSync={isRetryingSync}
          retrySyncError={retrySyncError}
          onRetrySync={() => void handleRetrySync()}
        />
      )}

      {!isLoading && workOrder && workOrder.status === 'DRAFT' && step === 'review' && (
        <ReviewStep
          workOrder={workOrder}
          isUploadingPhoto={isUploadingPhoto}
          uploadError={uploadError}
          category={category}
          onCategoryChange={setCategory}
          onFilesSelected={(files) => void handleFilesSelected(files)}
          removingPhotoId={removingPhotoId}
          onRemovePhoto={(photoId) => void handleRemovePhoto(photoId)}
          onContinue={() => setStep('sign')}
        />
      )}

      {!isLoading && workOrder && workOrder.status === 'DRAFT' && step === 'sign' && (
        <SignStep
          workOrder={workOrder}
          pendingWeekCount={pendingWeekCount}
          pendingWeekEntries={pendingWeekEntries}
          signerName={signerName}
          onSignerNameChange={setSignerName}
          signerFunction={signerFunction}
          onSignerFunctionChange={setSignerFunction}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
          signError={signError}
          isSigning={isSigning}
          signatureRef={signatureRef}
          signatureIsEmpty={signatureIsEmpty}
          onSignatureChange={() => setSignatureIsEmpty(signatureRef.current?.isEmpty() ?? true)}
          onBack={() => setStep('review')}
          onSign={() => void handleSign()}
        />
      )}
    </main>
  );
}

function ReviewStep({
  workOrder,
  isUploadingPhoto,
  uploadError,
  category,
  onCategoryChange,
  onFilesSelected,
  removingPhotoId,
  onRemovePhoto,
  onContinue,
}: {
  workOrder: WorkOrderSummary;
  isUploadingPhoto: boolean;
  uploadError: string | null;
  category: WorkOrderPhotoCategory | '';
  onCategoryChange: (category: WorkOrderPhotoCategory | '') => void;
  onFilesSelected: (files: FileList | null) => void;
  removingPhotoId: string | null;
  onRemovePhoto: (photoId: string) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <WorkOrderSummaryCard workOrder={workOrder} />

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-swatt-gold">Foto&apos;s</h2>

        {uploadError && (
          <p role="alert" className="mb-3 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">
            {uploadError}
          </p>
        )}

        {workOrder.photos.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {workOrder.photos.map((photo) => (
              <div key={photo.id} className="relative overflow-hidden rounded-lg border border-neutral-800">
                <img src={photo.thumbnailDataUrl} alt={photo.description ?? 'Werkbonfoto'} className="h-28 w-full object-cover" />
                {photo.category && (
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-neutral-200">
                    {WORK_ORDER_PHOTO_CATEGORY_LABELS[photo.category]}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemovePhoto(photo.id)}
                  disabled={removingPhotoId === photo.id}
                  aria-label="Foto verwijderen"
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-sm font-bold text-white disabled:opacity-60"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <label htmlFor="photo-category" className="mb-1 block text-sm text-neutral-300">
          Categorie (optioneel)
        </label>
        <select
          id="photo-category"
          value={category}
          onChange={(event) => onCategoryChange(event.target.value as WorkOrderPhotoCategory | '')}
          className="mb-4 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
        >
          <option value="">Geen categorie</option>
          {Object.entries(WORK_ORDER_PHOTO_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <div className="flex flex-col gap-3">
          <PhotoInputButton
            label={isUploadingPhoto ? 'Bezig...' : '+ Foto maken'}
            capture
            disabled={isUploadingPhoto}
            onFilesSelected={onFilesSelected}
          />
          <PhotoInputButton
            label={isUploadingPhoto ? 'Bezig...' : '+ Uit galerij'}
            disabled={isUploadingPhoto}
            onFilesSelected={onFilesSelected}
          />
        </div>
      </section>

      <button
        type="button"
        onClick={onContinue}
        className="rounded-xl bg-swatt-gold px-6 py-6 text-xl font-extrabold text-swatt-black"
      >
        Doorgaan naar ondertekenen
      </button>
    </div>
  );
}

function PhotoInputButton({
  label,
  capture,
  disabled,
  onFilesSelected,
}: {
  label: string;
  capture?: boolean;
  disabled: boolean;
  onFilesSelected: (files: FileList | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="rounded-lg border border-neutral-700 px-4 py-4 text-lg font-bold text-white disabled:opacity-60"
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={!capture}
        {...(capture ? { capture: 'environment' as const } : {})}
        className="hidden"
        onChange={(event) => {
          onFilesSelected(event.target.files);
          event.target.value = '';
        }}
      />
    </>
  );
}

function SignStep({
  workOrder,
  pendingWeekCount,
  pendingWeekEntries,
  signerName,
  onSignerNameChange,
  signerFunction,
  onSignerFunctionChange,
  confirmed,
  onConfirmedChange,
  signError,
  isSigning,
  signatureRef,
  signatureIsEmpty,
  onSignatureChange,
  onBack,
  onSign,
}: {
  workOrder: WorkOrderSummary;
  /** Phase 12, deel B — aantal werkbonnen dat samen met deze getekend wordt, enkel gezet bij projectSigningMode === 'WEEKLY'. */
  pendingWeekCount: number | null;
  /** Detail van alle tijdregistraties die samen met deze week ondertekend worden — op vraag: "alle tijden tonen zodat de ondertekenaar ziet wat hij goedkeurt". */
  pendingWeekEntries: PendingWeekEntrySummary[] | null;
  signerName: string;
  onSignerNameChange: (value: string) => void;
  signerFunction: string;
  onSignerFunctionChange: (value: string) => void;
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
  signError: string | null;
  isSigning: boolean;
  signatureRef: React.RefObject<SignatureCanvasHandle>;
  signatureIsEmpty: boolean;
  onSignatureChange: () => void;
  onBack: () => void;
  onSign: () => void;
}) {
  const canSubmit = signerName.trim().length > 0 && confirmed && !signatureIsEmpty && !isSigning;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-lg font-semibold">Werkbon controleren</p>
      <WorkOrderSummaryCard workOrder={workOrder} />

      {workOrder.projectSigningMode === 'WEEKLY' && pendingWeekCount !== null && pendingWeekCount > 1 && (
        <div className="rounded-lg border border-swatt-gold bg-neutral-900 px-4 py-3 text-sm text-swatt-gold">
          <p>
            Deze klant tekent per week. Deze handtekening bevestigt in één keer alle {pendingWeekCount} openstaande
            werkbonnen van deze week op dit project, niet enkel deze ene.
          </p>
          {pendingWeekEntries && pendingWeekEntries.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-md border border-swatt-gold/40">
              <table className="w-full text-left text-xs text-neutral-200">
                <thead>
                  <tr className="border-b border-swatt-gold/40 uppercase tracking-wide text-swatt-gold/80">
                    <th className="px-2 py-1.5">Medewerker</th>
                    <th className="px-2 py-1.5">Datum</th>
                    <th className="px-2 py-1.5">Van</th>
                    <th className="px-2 py-1.5">Tot</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingWeekEntries.map((entry, index) => (
                    <tr key={`${entry.workOrderId}-${index}`} className="border-b border-swatt-gold/10 last:border-0">
                      <td className="px-2 py-1.5">{entry.employeeDisplayName}</td>
                      <td className="px-2 py-1.5">{formatWeekEntryDate(entry.startedAt)}</td>
                      <td className="px-2 py-1.5">{formatWeekEntryTime(entry.startedAt)}</td>
                      <td className="px-2 py-1.5">{formatWeekEntryTime(entry.endedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {workOrder.photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {workOrder.photos.map((photo) => (
            <img
              key={photo.id}
              src={photo.thumbnailDataUrl}
              alt={photo.description ?? 'Werkbonfoto'}
              className="h-20 w-full rounded-lg object-cover"
            />
          ))}
        </div>
      )}

      {signError && (
        <p role="alert" className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
          {signError}
        </p>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <label htmlFor="signer-name" className="text-sm text-neutral-300">
          Naam klant / vertegenwoordiger
        </label>
        <input
          id="signer-name"
          type="text"
          value={signerName}
          onChange={(event) => onSignerNameChange(event.target.value)}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
        />

        <label htmlFor="signer-function" className="text-sm text-neutral-300">
          Functie (optioneel)
        </label>
        <input
          id="signer-function"
          type="text"
          value={signerFunction}
          onChange={(event) => onSignerFunctionChange(event.target.value)}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
        />

        <label className="flex items-start gap-3 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          Ik bevestig dat bovenstaande werkzaamheden werden uitgevoerd.
        </label>

        <p className="mt-2 text-sm text-neutral-300">Handtekening</p>
        <SignatureCanvas ref={signatureRef} onChange={onSignatureChange} />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              signatureRef.current?.clear();
              onSignatureChange();
            }}
            className="flex-1 rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-300"
          >
            Wissen
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onSign}
        disabled={!canSubmit}
        className="rounded-xl bg-swatt-gold px-6 py-6 text-xl font-extrabold text-swatt-black disabled:opacity-60"
      >
        {isSigning
          ? 'Bezig...'
          : workOrder.projectSigningMode === 'WEEKLY'
            ? 'Week ondertekenen en goedkeuren'
            : 'Ondertekenen en goedkeuren'}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={isSigning}
        className="rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-300 disabled:opacity-60"
      >
        Terug naar foto&apos;s
      </button>
    </div>
  );
}

function SignedWorkOrderView({
  workOrder,
  canManagePdf,
  isRegeneratingPdf,
  regeneratePdfError,
  onRegeneratePdf,
  isSendingToCustomer,
  sendToCustomerError,
  sendToCustomerSentAt,
  onSendToCustomer,
  isRetryingSync,
  retrySyncError,
  onRetrySync,
}: {
  workOrder: WorkOrderSummary;
  canManagePdf: boolean;
  isRegeneratingPdf: boolean;
  regeneratePdfError: string | null;
  onRegeneratePdf: () => void;
  isSendingToCustomer: boolean;
  sendToCustomerError: string | null;
  sendToCustomerSentAt: string | null;
  onSendToCustomer: () => void;
  isRetryingSync: boolean;
  retrySyncError: string | null;
  onRetrySync: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-emerald-900 bg-emerald-950 p-4 text-center text-sm text-emerald-200">
        Deze werkbon is ondertekend en kan niet meer gewijzigd worden.
      </div>
      <WorkOrderSummaryCard workOrder={workOrder} />

      {canManagePdf && (
        <TeamleaderSyncSection
          workOrder={workOrder}
          isRetryingSync={isRetryingSync}
          retrySyncError={retrySyncError}
          onRetrySync={onRetrySync}
        />
      )}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-swatt-gold">Werkbon-PDF</h2>
        <p className="text-sm text-neutral-300">{WORK_ORDER_PDF_STATUS_LABELS[workOrder.pdfStatus]}</p>

                {workOrder.pdfStatus === 'PDF_READY' && (
          <a
            href={`/work-orders/${workOrder.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block rounded-lg bg-swatt-gold px-4 py-3 text-sm font-bold text-swatt-black"
          >
            Download PDF
          </a>
        )}

        {workOrder.pdfStatus === 'PDF_READY' && (
          <div className="mt-3">
            <button
              type="button"
              onClick={onSendToCustomer}
              disabled={isSendingToCustomer}
              className="rounded-lg border border-swatt-gold px-4 py-3 text-sm font-semibold text-swatt-gold disabled:opacity-60"
            >
              {isSendingToCustomer ? 'Bezig...' : 'Verstuur naar klant'}
            </button>
            {sendToCustomerSentAt && (
              <p className="mt-2 text-sm text-emerald-300">
                Verstuurd op {new Date(sendToCustomerSentAt).toLocaleString('nl-BE')}
              </p>
            )}
            {sendToCustomerError && <p className="mt-2 text-sm text-red-300">{sendToCustomerError}</p>}
          </div>
        )}

        {workOrder.pdfStatus === 'PDF_FAILED' && (
          <div className="mt-3">
            {workOrder.pdfError && <p className="mb-2 text-sm text-red-300">{workOrder.pdfError}</p>}
            {canManagePdf ? (
              <button
                type="button"
                onClick={onRegeneratePdf}
                disabled={isRegeneratingPdf}
                className="rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-200 disabled:opacity-60"
              >
                {isRegeneratingPdf ? 'Bezig...' : 'PDF opnieuw genereren'}
              </button>
            ) : (
              <p className="text-sm text-neutral-500">Vraag een supervisor of beheerder om de PDF opnieuw te genereren.</p>
            )}
            {regeneratePdfError && <p className="mt-2 text-sm text-red-300">{regeneratePdfError}</p>}
          </div>
        )}
      </section>

      {workOrder.photos.length > 0 && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-swatt-gold">Foto&apos;s</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {workOrder.photos.map((photo) => (
              <img
                key={photo.id}
                src={photo.thumbnailDataUrl}
                alt={photo.description ?? 'Werkbonfoto'}
                className="h-28 w-full rounded-lg object-cover"
              />
            ))}
          </div>
        </section>
      )}

      {workOrder.signature && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-swatt-gold">Goedkeuring klant</h2>
          <img src={workOrder.signature.imageDataUrl} alt="Handtekening klant" className="mb-3 h-32 rounded-lg bg-white" />
          <p className="text-sm text-white">{workOrder.signature.signerName}</p>
          {workOrder.signature.signerFunction && (
            <p className="text-sm text-neutral-400">{workOrder.signature.signerFunction}</p>
          )}
          <p className="mt-1 text-xs text-neutral-500">{new Date(workOrder.signature.signedAt).toLocaleString('nl-BE')}</p>
        </section>
      )}
    </div>
  );
}

/**
 * Phase 9 — sectie 13/14/34: toont de voortgang van de Teamleader-sync (uren
 * + PDF-upload) en biedt SUPERVISOR+ de "Opnieuw synchroniseren"-herstelactie
 * uit sectie 13 aan zodra minstens één van beide gefaald is. Enkel zichtbaar
 * voor wie de PDF ook mag beheren (canManagePdf) — dezelfde SUPERVISOR+-grens.
 */
function TeamleaderSyncSection({
  workOrder,
  isRetryingSync,
  retrySyncError,
  onRetrySync,
}: {
  workOrder: WorkOrderSummary;
  isRetryingSync: boolean;
  retrySyncError: string | null;
  onRetrySync: () => void;
}) {
  const hasFailure = workOrder.timeTrackingSyncStatus === 'FAILED' || workOrder.teamleaderUploadStatus === 'TEAMLEADER_UPLOAD_FAILED';

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-swatt-gold">Teamleader-synchronisatie</h2>
      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-neutral-400">Uren</dt>
          <dd className={workOrder.timeTrackingSyncStatus === 'FAILED' ? 'text-red-300' : 'text-neutral-200'}>
            {WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS[workOrder.timeTrackingSyncStatus]}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-neutral-400">Werkbon-PDF</dt>
          <dd className={workOrder.teamleaderUploadStatus === 'TEAMLEADER_UPLOAD_FAILED' ? 'text-red-300' : 'text-neutral-200'}>
            {WORK_ORDER_TEAMLEADER_UPLOAD_STATUS_LABELS[workOrder.teamleaderUploadStatus]}
          </dd>
        </div>
      </dl>

      {workOrder.timeTrackingSyncError && (
        <p className="mt-3 text-sm text-red-300">{workOrder.timeTrackingSyncError}</p>
      )}
      {workOrder.teamleaderUploadError && (
        <p className="mt-1 text-sm text-red-300">{workOrder.teamleaderUploadError}</p>
      )}
      {retrySyncError && <p className="mt-2 text-sm text-red-300">{retrySyncError}</p>}

      {hasFailure && (
        <>
          <button
            type="button"
            onClick={onRetrySync}
            disabled={isRetryingSync}
            className="mt-4 rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-200 disabled:opacity-60"
          >
            {isRetryingSync ? 'Bezig met synchroniseren met Teamleader...' : 'Opnieuw synchroniseren'}
          </button>
          {isRetryingSync && (
            <p className="mt-2 text-xs text-neutral-500">
              Dit kan enkele seconden duren — dit scherm werkt zichzelf automatisch bij.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function WorkOrderSummaryCard({ workOrder }: { workOrder: WorkOrderSummary }) {
  const totalSeconds = workOrder.timeEntries.reduce((sum, entry) => {
    if (!entry.endedAt) return sum;
    const worked = (new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000 - entry.pausedSeconds;
    return sum + Math.max(0, worked);
  }, 0);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-swatt-gold">{workOrder.customerName}</p>
      <p className="mt-1 text-lg font-semibold">{workOrder.projectName}</p>
      <p className="mt-1 text-sm text-neutral-400">{workOrder.workOrderNumber}</p>
      {workOrder.description && <p className="mt-3 text-sm text-neutral-200">{workOrder.description}</p>}

      <div className="mt-4 flex flex-col gap-1">
        {workOrder.timeEntries.map((entry) => (
          <div key={entry.id} className="flex items-center justify-between text-sm text-neutral-300">
            <span>{entry.employeeDisplayName}</span>
            <span className="tabular-nums text-neutral-400">
              {new Date(entry.startedAt).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}
              {' – '}
              {entry.endedAt
                ? new Date(entry.endedAt).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
                : '...'}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-right text-sm font-semibold text-swatt-gold">Totaal: {formatDuration(totalSeconds)}</p>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}u ${String(minutes).padStart(2, '0')}min`;
}

function formatWeekEntryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function formatWeekEntryTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}
