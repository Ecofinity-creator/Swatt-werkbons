import type { TimeEntryActivityType, TimeEntrySummary } from '@swatt/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { timeEntriesApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

/**
 * Op vraag (4/9/2026, in het kader van de Belgische verplichte
 * urenregistratie vanaf 1/1/2027 — "objectief, betrouwbaar en toegankelijk
 * systeem" moet ALLE arbeidstijd omvatten, niet enkel klant-facturabele
 * projecturen): verplaatsing tussen werven, interne vergadering, opleiding
 * en overige niet-projectgebonden arbeidstijd. Zelfde START/PAUZE/STOP-
 * timerflow als ProjectTimerPage.tsx, bewust vereenvoudigd (geen foto's,
 * geen klant-ondertekening — er is immers geen klant) en zonder werkbon:
 * de registratie wordt gewoon permanent bewaard op TimeEntry zelf, zichtbaar
 * op "Mijn werkbonnen".
 */
const ACTIVITY_TYPE_OPTIONS: { value: Exclude<TimeEntryActivityType, 'PROJECT_WORK'>; label: string }[] = [
  { value: 'TRAVEL', label: 'Verplaatsing tussen werven' },
  { value: 'INTERNAL', label: 'Interne vergadering / administratie' },
  { value: 'TRAINING', label: 'Opleiding' },
  { value: 'OTHER', label: 'Overige' },
];

export function GeneralTimeEntryPage() {
  const [activeEntry, setActiveEntry] = useState<TimeEntrySummary | null | undefined>(undefined);
  const [selectedType, setSelectedType] = useState<Exclude<TimeEntryActivityType, 'PROJECT_WORK'>>('TRAVEL');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    timeEntriesApi
      .active()
      .then((response) => setActiveEntry(response.timeEntry))
      .catch(() => setActiveEntry(null));
  }, []);

  useEffect(() => {
    if (activeEntry?.status !== 'RUNNING') return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeEntry?.status]);

  const elapsedSeconds = useMemo(() => (activeEntry ? computeElapsedSeconds(activeEntry, nowMs) : 0), [activeEntry, nowMs]);
  const isGeneralEntry = activeEntry != null && activeEntry.activityType !== 'PROJECT_WORK';
  const isProjectEntry = activeEntry != null && activeEntry.activityType === 'PROJECT_WORK';

  async function handleStart() {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const response = await timeEntriesApi.startGeneral({ activityType: selectedType, description: description.trim() || undefined });
      setActiveEntry(response.timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Starten is mislukt.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePause() {
    if (!activeEntry) return;
    setIsSubmitting(true);
    try {
      setActiveEntry((await timeEntriesApi.pause(activeEntry.id)).timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Pauzeren is mislukt.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResume() {
    if (!activeEntry) return;
    setIsSubmitting(true);
    try {
      setActiveEntry((await timeEntriesApi.resume(activeEntry.id)).timeEntry);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Hervatten is mislukt.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleStop() {
    if (!activeEntry) return;
    setIsSubmitting(true);
    try {
      await timeEntriesApi.stop(activeEntry.id, description.trim() || undefined);
      setActiveEntry(null);
      setDescription('');
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Stoppen is mislukt.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">Algemene tijdregistratie</h1>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      <p className="mb-6 text-sm text-neutral-400">
        Voor arbeidstijd die niet aan één klantproject gekoppeld is — verplaatsing, interne vergadering, opleiding of
        overige.
      </p>

      {errorMessage && (
        <p className="mb-4 rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-200">{errorMessage}</p>
      )}

      {activeEntry === undefined && <p className="text-neutral-400">Laden...</p>}

      {isProjectEntry && (
        <div className="rounded-lg border border-swatt-gold bg-neutral-900 px-4 py-4 text-sm text-swatt-gold">
          Je hebt al een actieve tijdsregistratie lopen op <strong>{activeEntry.projectName}</strong>. Stop deze eerst
          voor je hier een algemene registratie kan starten.
          <Link to={`/projecten/${activeEntry.projectId}`} className="mt-3 block underline">
            Naar dat project
          </Link>
        </div>
      )}

      {!isProjectEntry && isGeneralEntry && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-6 text-center">
          <p className="mb-1 text-sm text-neutral-400">
            {ACTIVITY_TYPE_OPTIONS.find((o) => o.value === activeEntry.activityType)?.label}
          </p>
          <p className="mb-4 text-4xl font-bold tabular-nums text-swatt-gold">{formatHms(elapsedSeconds)}</p>
          <div className="flex gap-3">
            {activeEntry.status === 'RUNNING' ? (
              <button
                type="button"
                onClick={() => void handlePause()}
                disabled={isSubmitting}
                className="flex-1 rounded-lg border border-neutral-700 py-3 text-sm font-semibold text-neutral-200 disabled:opacity-50"
              >
                Pauzeren
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleResume()}
                disabled={isSubmitting}
                className="flex-1 rounded-lg border border-neutral-700 py-3 text-sm font-semibold text-neutral-200 disabled:opacity-50"
              >
                Hervatten
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={isSubmitting}
              className="flex-1 rounded-lg bg-swatt-gold py-3 text-sm font-bold text-swatt-black disabled:opacity-50"
            >
              Stoppen
            </button>
          </div>
        </div>
      )}

      {!isProjectEntry && !isGeneralEntry && activeEntry !== undefined && (
        <>
          <p className="mb-2 text-sm font-semibold text-neutral-300">Type activiteit</p>
          <div className="mb-4 space-y-2">
            {ACTIVITY_TYPE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
              >
                <input
                  type="radio"
                  name="activityType"
                  checked={selectedType === option.value}
                  onChange={() => setSelectedType(option.value)}
                  className="h-4 w-4 accent-swatt-gold"
                />
                {option.label}
              </label>
            ))}
          </div>

          <label className="mb-6 block text-sm text-neutral-300">
            Omschrijving (optioneel)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white outline-none focus:border-swatt-gold"
            />
          </label>

          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={isSubmitting}
            className="rounded-lg bg-swatt-gold py-4 text-center text-base font-bold text-swatt-black disabled:opacity-50"
          >
            {isSubmitting ? 'Bezig...' : 'START'}
          </button>
        </>
      )}
    </main>
  );
}

function computeElapsedSeconds(entry: TimeEntrySummary, nowMs: number): number {
  const startedMs = new Date(entry.startedAt).getTime();
  if (entry.status === 'RUNNING') {
    return Math.max(0, Math.floor((nowMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  if (entry.status === 'PAUSED' && entry.currentPauseStartedAt) {
    const pauseStartedMs = new Date(entry.currentPauseStartedAt).getTime();
    return Math.max(0, Math.floor((pauseStartedMs - startedMs) / 1000) - entry.pausedSeconds);
  }
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000) - entry.pausedSeconds);
}

function formatHms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
