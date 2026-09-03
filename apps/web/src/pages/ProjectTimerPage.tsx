import type { ProjectSummary, TimeEntrySummary, WorkOrderDraftSummary } from '@swatt/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { projectsApi, timeEntriesApi, workOrdersApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

/**
 * Phase 5 — werkbonnen (basis). De werkbon wordt automatisch aangemaakt
 * meteen na een geslaagde stop (geen aparte "werkbon aanmaken"-klik). Business
 * rule 9 (sectie 24): een storing bij die aanmaak mag de al veilig
 * opgeslagen tijdsregistratie nooit "verliezen" — vandaar `workOrderError` +
 * een expliciete herprobeer-knop i.p.v. de hele stop-actie te laten falen.
 */
interface StoppedSummary {
  elapsedSeconds: number;
  description: string | null;
  timeEntryId: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  workOrderError: string | null;
}

/**
 * Phase 4 — "START WERK". Bereikbaar via een projectkaart op "Mijn
 * projecten" (die geeft het project mee als router-`state`, zodat hier geen
 * extra fetch nodig is), maar moet ook correct werken bij een rechtstreekse
 * navigatie/herlaad (bv. gedeelde link, browser-herlaad tijdens een lopende
 * timer) — vandaar de fallback op `projectsApi.mine()` hieronder.
 *
 * De "verstreken tijd" wordt bewust NIET van de backend gehaald als kant-en-
 * klare waarde (zie TimeEntrySummary in shared-types) — die zou meteen
 * verouderd zijn. In plaats daarvan berekent en tikt deze pagina de tijd zelf,
 * elke seconde opnieuw, op basis van `startedAt`/`pausedSeconds`/
 * `currentPauseStartedAt`.
 */
export function ProjectTimerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const stateProject = (location.state as { project?: ProjectSummary } | null)?.project;

  const [project, setProject] = useState<ProjectSummary | null>(stateProject ?? null);
  const [activeEntry, setActiveEntry] = useState<TimeEntrySummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showStopForm, setShowStopForm] = useState(false);
  const [description, setDescription] = useState('');
  const [stoppedSummary, setStoppedSummary] = useState<StoppedSummary | null>(null);
  const [isCreatingWorkOrder, setIsCreatingWorkOrder] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Op vraag (3/9/2026): "hoe kan de installateur naar de niet-getekende
  // werkbonnen van zijn klant gaan zonder een nieuwe aan te maken" — bv. op
  // het einde van de week naar de verantwoordelijke stappen om ze te laten
  // tekenen. Enkel de eigen (mee-uitgevoerde) DRAFT-werkbonnen van dit project.
  const [draftWorkOrders, setDraftWorkOrders] = useState<WorkOrderDraftSummary[] | null>(null);

  // Sectie 6 — "manueel tijd toevoegen indien toegestaan": alternatief voor
  // START/PAUZE/STOP wanneer een werknemer een vaste periode achteraf wil
  // ingeven (bv. de timer vergeten te starten).
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDate, setManualDate] = useState(() => toDateInputValue(new Date()));
  const [manualStartTime, setManualStartTime] = useState('');
  const [manualEndTime, setManualEndTime] = useState('');
  const [manualPauseMinutes, setManualPauseMinutes] = useState('0');
  const [manualDescription, setManualDescription] = useState('');
  const [manualErrorMessage, setManualErrorMessage] = useState<string | null>(null);
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    async function load() {
      try {
        const [activeResponse] = await Promise.all([
          timeEntriesApi.active(),
          stateProject
            ? Promise.resolve(null)
            : projectsApi.mine().then((res) => {
                const match = res.projects.find((p) => p.id === projectId);
                if (!cancelled) setProject(match ?? null);
              }),
        ]);
        if (!cancelled) setActiveEntry(activeResponse.timeEntry);
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de timerstatus niet ophalen.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateProject is een stabiele snapshot uit de navigatie, geen reactieve dependency
  }, [projectId]);

  // Op vraag (3/9/2026) — zie de toelichting bij draftWorkOrders hierboven.
  // Ook opnieuw ophalen na het aanmaken van een werkbon (stoppedSummary
  // wijzigt dan), zodat de nieuwe werkbon meteen in de lijst verschijnt.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    workOrdersApi
      .listDrafts(projectId)
      .then((response) => {
        if (!cancelled) setDraftWorkOrders(response.workOrders);
      })
      .catch(() => {
        if (!cancelled) setDraftWorkOrders(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stoppedSummary]);

  // Tikt elke seconde door zodat een lopende timer live meetelt.
  useEffect(() => {
    if (activeEntry?.status !== 'RUNNING') return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeEntry?.status]);

  const elapsedSeconds = useMemo(() => (activeEntry ? computeElapsedSeconds(activeEntry, nowMs) : 0), [activeEntry, nowMs]);

  if (!projectId) {
    return null;
  }

  async function handleStart() {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const response = await timeEntriesApi.start(projectId!);
      setActiveEntry(response.timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de timer niet starten.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePause() {
    if (!activeEntry) return;
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const response = await timeEntriesApi.pause(activeEntry.id);
      setActiveEntry(response.timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de timer niet pauzeren.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResume() {
    if (!activeEntry) return;
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const response = await timeEntriesApi.resume(activeEntry.id);
      setActiveEntry(response.timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de timer niet hervatten.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleStop() {
    if (!activeEntry) return;
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const trimmedDescription = description.trim() || undefined;
      const response = await timeEntriesApi.stop(activeEntry.id, trimmedDescription);
      const stoppedEntry = response.timeEntry;
      setActiveEntry(null);
      setShowStopForm(false);
      setDescription('');
      setStoppedSummary({
        elapsedSeconds: computeElapsedSeconds(stoppedEntry, Date.now()),
        description: stoppedEntry.description,
        timeEntryId: stoppedEntry.id,
        workOrderId: null,
        workOrderNumber: null,
        workOrderError: null,
      });
      await createWorkOrder(stoppedEntry.id, trimmedDescription ?? null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de timer niet stoppen.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Faalt deze aanroep, dan blijft de al gestopte/opgeslagen tijdsregistratie
   * gewoon behouden (business rule 9) — `stoppedSummary` toont dan een
   * duidelijke foutmelding met een herprobeer-knop i.p.v. de gebruiker terug
   * naar "START WERK" te sturen alsof er niets gebeurd is.
   */
  async function createWorkOrder(timeEntryId: string, descriptionValue: string | null) {
    if (!projectId) return;
    setIsCreatingWorkOrder(true);
    try {
      const response = await workOrdersApi.create({
        projectId,
        timeEntryIds: [timeEntryId],
        ...(descriptionValue ? { description: descriptionValue } : {}),
      });
      setStoppedSummary((prev) =>
        prev
          ? {
              ...prev,
              workOrderId: response.workOrder.id,
              workOrderNumber: response.workOrder.workOrderNumber,
              workOrderError: null,
            }
          : prev,
      );
    } catch (err) {
      setStoppedSummary((prev) =>
        prev
          ? {
              ...prev,
              workOrderError: err instanceof ApiRequestError ? err.message : 'Kon de werkbon niet aanmaken.',
            }
          : prev,
      );
    } finally {
      setIsCreatingWorkOrder(false);
    }
  }

  /**
   * Sectie 6 — "manueel tijd toevoegen indien toegestaan". Bouwt lokale
   * datum + start-/einduur om naar volledige ISO-tijdstippen (via `new
   * Date(...)`, wat de tijdzone van het toestel gebruikt — dezelfde aanpak
   * als een natief `<input type="time">`) en maakt daarna een meteen-STOPPED
   * registratie aan die dezelfde werkbon-aanmaak-flow doorloopt als een
   * gestopte timer (zie createWorkOrder hierboven) — zo blijft er precies één
   * pad van "tijdsregistratie" naar "werkbon", ongeacht hoe de registratie
   * tot stand kwam.
   */
  async function handleManualSubmit() {
    if (!projectId) return;
    setManualErrorMessage(null);

    if (!manualStartTime || !manualEndTime) {
      setManualErrorMessage('Vul zowel een begin- als einduur in.');
      return;
    }

    const startedAt = new Date(`${manualDate}T${manualStartTime}:00`);
    const endedAt = new Date(`${manualDate}T${manualEndTime}:00`);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      setManualErrorMessage('Ongeldige datum of tijd.');
      return;
    }
    if (endedAt.getTime() <= startedAt.getTime()) {
      setManualErrorMessage('Einduur moet na het beginuur liggen.');
      return;
    }

    const pauseMinutesValue = Number.parseInt(manualPauseMinutes, 10);
    const pausedMinutes = Number.isNaN(pauseMinutesValue) ? 0 : Math.max(0, pauseMinutesValue);

    setIsSubmittingManual(true);
    try {
      const trimmedDescription = manualDescription.trim() || undefined;
      const response = await timeEntriesApi.createManual({
        projectId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        pausedMinutes,
        description: trimmedDescription,
      });
      const createdEntry = response.timeEntry;
      setShowManualForm(false);
      setManualStartTime('');
      setManualEndTime('');
      setManualPauseMinutes('0');
      setManualDescription('');
      setStoppedSummary({
        elapsedSeconds: computeElapsedSeconds(createdEntry, Date.now()),
        description: createdEntry.description,
        timeEntryId: createdEntry.id,
        workOrderId: null,
        workOrderNumber: null,
        workOrderError: null,
      });
      await createWorkOrder(createdEntry.id, trimmedDescription ?? null);
    } catch (err) {
      setManualErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de tijdsregistratie niet opslaan.');
    } finally {
      setIsSubmittingManual(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Tijdsregistratie</p>
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

      {!isLoading && !project && !errorMessage && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-center text-neutral-400">
          Dit project is niet gevonden of niet aan jou gekoppeld.
        </div>
      )}

      {!isLoading && project && stoppedSummary && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
          <p className="text-lg font-semibold">Tijdsregistratie gestopt</p>
          <p className="text-4xl font-extrabold tabular-nums text-swatt-gold">
            {formatDuration(stoppedSummary.elapsedSeconds)}
          </p>
          {stoppedSummary.description && (
            <p className="max-w-sm text-sm text-neutral-400">&ldquo;{stoppedSummary.description}&rdquo;</p>
          )}

          {stoppedSummary.workOrderNumber ? (
            <div className="w-full rounded-lg bg-neutral-800 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-neutral-400">Werkbon</p>
              <p className="text-lg font-bold text-white">{stoppedSummary.workOrderNumber}</p>
              {stoppedSummary.workOrderId && (
                <Link
                  to={`/werkbonnen/${stoppedSummary.workOrderId}`}
                  className="mt-3 block rounded-lg bg-swatt-gold px-4 py-3 text-center text-sm font-bold text-swatt-black"
                >
                  Werkbon afwerken (foto&apos;s &amp; handtekening) →
                </Link>
              )}
            </div>
          ) : stoppedSummary.workOrderError ? (
            <div className="w-full rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
              <p>{stoppedSummary.workOrderError}</p>
              <p className="mt-1 text-red-400">Je tijdsregistratie is wel veilig opgeslagen.</p>
              <button
                type="button"
                onClick={() => void createWorkOrder(stoppedSummary.timeEntryId, stoppedSummary.description)}
                disabled={isCreatingWorkOrder}
                className="mt-3 rounded-lg bg-swatt-gold px-4 py-2 text-sm font-bold text-swatt-black disabled:opacity-60"
              >
                {isCreatingWorkOrder ? 'Bezig...' : 'Opnieuw proberen'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-neutral-400">Werkbon aanmaken...</p>
          )}

          <Link
            to="/mijn-projecten"
            className="mt-2 rounded-lg bg-swatt-gold px-6 py-3 text-sm font-bold text-swatt-black"
          >
            Naar mijn projecten
          </Link>
        </div>
      )}

      {!isLoading && project && !stoppedSummary && (
        <>
          <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-swatt-gold">{project.customerName}</p>
            <p className="mt-1 text-lg font-semibold">{project.name}</p>
            {project.address && <p className="mt-1 text-sm text-neutral-400">{project.address}</p>}
          </div>

          {showManualForm ? (
            <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <p className="text-sm font-semibold text-white">Tijd manueel ingeven</p>
              {manualErrorMessage && (
                <p role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">
                  {manualErrorMessage}
                </p>
              )}
              <label htmlFor="manual-date" className="text-sm text-neutral-300">
                Datum
              </label>
              <input
                id="manual-date"
                type="date"
                value={manualDate}
                onChange={(event) => setManualDate(event.target.value)}
                max={toDateInputValue(new Date())}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
              />
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="manual-start" className="text-sm text-neutral-300">
                    Van
                  </label>
                  <input
                    id="manual-start"
                    type="time"
                    value={manualStartTime}
                    onChange={(event) => setManualStartTime(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
                  />
                </div>
                <div className="flex-1">
                  <label htmlFor="manual-end" className="text-sm text-neutral-300">
                    Tot
                  </label>
                  <input
                    id="manual-end"
                    type="time"
                    value={manualEndTime}
                    onChange={(event) => setManualEndTime(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
                  />
                </div>
              </div>
              <label htmlFor="manual-pause" className="text-sm text-neutral-300">
                Pauze (minuten)
              </label>
              <input
                id="manual-pause"
                type="number"
                inputMode="numeric"
                min={0}
                value={manualPauseMinutes}
                onChange={(event) => setManualPauseMinutes(event.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
              />
              <label htmlFor="manual-description" className="text-sm text-neutral-300">
                Omschrijving (optioneel)
              </label>
              <textarea
                id="manual-description"
                rows={4}
                value={manualDescription}
                onChange={(event) => setManualDescription(event.target.value)}
                placeholder="Uitgevoerde werkzaamheden..."
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
              />
              <button
                type="button"
                onClick={() => void handleManualSubmit()}
                disabled={isSubmittingManual}
                className="rounded-lg bg-swatt-gold px-4 py-4 text-lg font-bold text-swatt-black disabled:opacity-60"
              >
                {isSubmittingManual ? 'Bezig met opslaan...' : 'Tijd opslaan'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowManualForm(false);
                  setManualErrorMessage(null);
                }}
                disabled={isSubmittingManual}
                className="rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-300 disabled:opacity-60"
              >
                Annuleren
              </button>
            </div>
          ) : (
            <>
              {(!activeEntry || activeEntry.projectId !== projectId) && (
                <button
                  type="button"
                  onClick={() => setShowManualForm(true)}
                  className="mb-6 w-full rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-300"
                >
                  Tijd manueel ingeven
                </button>
              )}

              {activeEntry && activeEntry.projectId !== projectId ? (
            <div className="rounded-xl border border-amber-900 bg-amber-950 p-5 text-center">
              <p className="text-sm text-amber-200">
                Je hebt al een actieve tijdsregistratie lopen op <strong>{activeEntry.projectName}</strong> bij{' '}
                {activeEntry.customerName}. Stop deze eerst voor je hier kan starten.
              </p>
              <Link
                to={`/projecten/${activeEntry.projectId}`}
                className="mt-4 inline-block rounded-lg bg-swatt-gold px-6 py-3 text-sm font-bold text-swatt-black"
              >
                Ga naar actieve registratie
              </Link>
            </div>
          ) : activeEntry ? (
            <div className="flex flex-col items-center gap-6 rounded-xl border border-neutral-800 bg-neutral-900 p-8">
              {activeEntry.status === 'PAUSED' && (
                <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-300">
                  Gepauzeerd
                </span>
              )}
              <p
                className={`text-6xl font-extrabold tabular-nums ${
                  activeEntry.status === 'PAUSED' ? 'text-neutral-500' : 'text-swatt-gold'
                }`}
              >
                {formatDuration(elapsedSeconds)}
              </p>

              {!showStopForm ? (
                <div className="flex w-full flex-col gap-3">
                  {activeEntry.status === 'RUNNING' ? (
                    <button
                      type="button"
                      onClick={() => void handlePause()}
                      disabled={isSubmitting}
                      className="rounded-lg border border-neutral-700 px-4 py-4 text-lg font-bold text-white disabled:opacity-60"
                    >
                      Pauzeren
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleResume()}
                      disabled={isSubmitting}
                      className="rounded-lg bg-swatt-gold px-4 py-4 text-lg font-bold text-swatt-black disabled:opacity-60"
                    >
                      Hervatten
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowStopForm(true)}
                    disabled={isSubmitting}
                    className="rounded-lg bg-red-900 px-4 py-4 text-lg font-bold text-white disabled:opacity-60"
                  >
                    Stoppen
                  </button>
                </div>
              ) : (
                <div className="flex w-full flex-col gap-3">
                  <label htmlFor="description" className="text-sm text-neutral-300">
                    Omschrijving (optioneel)
                  </label>
                  <textarea
                    id="description"
                    rows={4}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Uitgevoerde werkzaamheden..."
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
                  />
                  <button
                    type="button"
                    onClick={() => void handleStop()}
                    disabled={isSubmitting}
                    className="rounded-lg bg-red-900 px-4 py-4 text-lg font-bold text-white disabled:opacity-60"
                  >
                    {isSubmitting ? 'Bezig met stoppen...' : 'Bevestig stoppen'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowStopForm(false)}
                    disabled={isSubmitting}
                    className="rounded-lg border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-300 disabled:opacity-60"
                  >
                    Annuleren
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={isSubmitting}
              className="rounded-xl bg-swatt-gold px-6 py-8 text-2xl font-extrabold text-swatt-black transition active:bg-swatt-gold-dark disabled:opacity-60"
            >
              {isSubmitting ? 'Bezig met starten...' : 'START WERK'}
            </button>
          )}
            </>
          )}
        </>
      )}

      {!isLoading && project && draftWorkOrders && draftWorkOrders.length > 0 && (
        <section className="mt-8 border-t border-neutral-800 pt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Nog niet getekende werkbonnen
          </h2>
          <p className="mb-3 text-xs text-neutral-500">
            Bv. op het einde van de week: ga hiernaartoe om ze door de klant te laten tekenen — zonder een nieuwe aan
            te maken.
          </p>
          <ul className="space-y-2">
            {draftWorkOrders.map((draft) => (
              <li key={draft.id}>
                <Link
                  to={`/werkbonnen/${draft.id}`}
                  className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 active:bg-neutral-800"
                >
                  <span>
                    <span className="block text-sm font-semibold">{draft.workOrderNumber}</span>
                    <span className="block text-xs text-neutral-400">
                      {formatDraftDate(draft.createdAt)} · {formatDraftDuration(draft.totalSeconds)}
                    </span>
                  </span>
                  <span className="text-swatt-gold">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * `pausedSeconds` bevat enkel afgeronde pauze-intervallen; de nog lopende
 * pauze (status PAUSED) wordt hier apart verrekend via `currentPauseStartedAt`
 * — zelfde rekenlogica als TimeEntryService.resume()/stop() aan de
 * backend-kant, maar dan lokaal en "live" (met het huidige moment i.p.v. het
 * moment van een server-call).
 */
function formatDraftDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDraftDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}u ${String(minutes).padStart(2, '0')}min`;
}

function computeElapsedSeconds(entry: TimeEntrySummary, nowMs: number): number {
  const startedMs = new Date(entry.startedAt).getTime();

  if (entry.status === 'RUNNING') {
    return Math.max(0, Math.floor((nowMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  if (entry.status === 'PAUSED' && entry.currentPauseStartedAt) {
    const pauseStartMs = new Date(entry.currentPauseStartedAt).getTime();
    return Math.max(0, Math.floor((pauseStartMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  if (entry.endedAt) {
    const endedMs = new Date(entry.endedAt).getTime();
    return Math.max(0, Math.floor((endedMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  return 0;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Lokale datum als "YYYY-MM-DD" voor een native `<input type="date">` — bewust NIET via `.toISOString()`, want dat zou naar UTC omzetten en rond middernacht de verkeerde dag kunnen tonen. */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
