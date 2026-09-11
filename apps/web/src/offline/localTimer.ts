import type { TimeEntrySummary } from '@swatt/shared-types';

/**
 * Offline-modus (sectie 16), deel 2 — een volledig lokale "schaduw-timer"
 * voor het geval een technieker op START WERK drukt zonder bereik (dus vóór
 * `timeEntriesApi.start()` ooit een echte, server-toegekende ID kon geven).
 *
 * BEWUSTE KEUZE: dit hergebruikt exact de vorm van `TimeEntrySummary` (zie
 * shared-types) met een lokaal `local-`-ID i.p.v. een apart datamodel te
 * verzinnen — ProjectTimerPage.tsx's bestaande client-side klok/berekening
 * (`computeElapsedSeconds`) werkt daardoor ONGEWIJZIGD voor een lokale
 * timer, exact zoals voor een echte. Pauzeren/hervatten gebeurt hier met
 * dezelfde rekenkunde als TimeEntryService.pause()/resume() op de backend.
 *
 * Bij het uiteindelijk stoppen (online of offline) wordt dit NOOIT alsnog
 * via start/pause/resume/stop naar de server gestuurd — dat zou een reeks
 * server-IDs veronderstellen die nooit bestonden. In plaats daarvan wordt de
 * volledige sessie in één keer als manuele tijdregistratie ingediend (zie
 * offline/outbox.ts) — functioneel identiek, enkel met `isManual: true` als
 * (zuiver informatief) verschil.
 */

const STORAGE_KEY = 'uurivo.offlineTimer.v1';
const LOCAL_ID_PREFIX = 'local-';

export function isLocalTimerId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

export function loadLocalTimer(): TimeEntrySummary | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TimeEntrySummary;
  } catch {
    return null;
  }
}

function saveLocalTimer(entry: TimeEntrySummary | null): void {
  try {
    if (entry) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage kan uitzonderlijk falen (privé-venster, volle opslag) —
    // de timer blijft dan gewoon in het React-geheugen werken zolang het
    // tabblad open blijft, enkel het "overleeft een herlaad"-voordeel valt weg.
  }
}

export function startLocalTimer(project: { id: string; name: string; customerName?: string | null }): TimeEntrySummary {
  const entry: TimeEntrySummary = {
    id: `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`,
    projectId: project.id,
    projectName: project.name,
    customerName: project.customerName ?? null,
    activityType: 'PROJECT_WORK',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    endedAt: null,
    pausedSeconds: 0,
    currentPauseStartedAt: null,
    description: null,
    isManual: false,
  };
  saveLocalTimer(entry);
  return entry;
}

export function pauseLocalTimer(entry: TimeEntrySummary): TimeEntrySummary {
  const next: TimeEntrySummary = { ...entry, status: 'PAUSED', currentPauseStartedAt: new Date().toISOString() };
  saveLocalTimer(next);
  return next;
}

export function resumeLocalTimer(entry: TimeEntrySummary): TimeEntrySummary {
  const pauseStart = entry.currentPauseStartedAt ? new Date(entry.currentPauseStartedAt).getTime() : Date.now();
  const additionalPausedSeconds = Math.max(0, Math.floor((Date.now() - pauseStart) / 1000));
  const next: TimeEntrySummary = {
    ...entry,
    status: 'RUNNING',
    pausedSeconds: entry.pausedSeconds + additionalPausedSeconds,
    currentPauseStartedAt: null,
  };
  saveLocalTimer(next);
  return next;
}

/** Stopt en geeft meteen de definitieve waarden terug — de aanroeper (ProjectTimerPage) bouwt hiermee de outbox-payload en wist daarna de lokale timer via `clearLocalTimer()`. */
export function stopLocalTimer(entry: TimeEntrySummary, description: string | null): { startedAt: string; endedAt: string; pausedSeconds: number; description: string | null } {
  const now = new Date();
  const extraPausedSeconds =
    entry.status === 'PAUSED' && entry.currentPauseStartedAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(entry.currentPauseStartedAt).getTime()) / 1000))
      : 0;
  return {
    startedAt: entry.startedAt,
    endedAt: now.toISOString(),
    pausedSeconds: entry.pausedSeconds + extraPausedSeconds,
    description,
  };
}

export function clearLocalTimer(): void {
  saveLocalTimer(null);
}

export function updateLocalTimerDescription(entry: TimeEntrySummary, description: string): TimeEntrySummary {
  const next: TimeEntrySummary = { ...entry, description };
  saveLocalTimer(next);
  return next;
}
