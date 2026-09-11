import { timeEntriesApi, workOrdersApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

/**
 * Offline-modus (sectie 16), deel 3 — de lokale wachtrij ("outbox") voor
 * schrijfacties die niet meteen naar de server konden. Bewust `localStorage`
 * i.p.v. IndexedDB: deze items zijn kleine JSON-metadata (geen foto's/
 * bestanden — zie de beperking hieronder), en localStorage is synchroon en
 * eenvoudig genoeg voor dit volume. Foto's/handtekening offline aanbieden
 * vraagt een eigen vervolgstap (blob-opslag in IndexedDB + een "voorlopige
 * werkbon"-detailscherm) — bewust NIET in deze eerste versie, zie de
 * toelichting die hiervan bij ProjectTimerPage/README hoort.
 *
 * ROBUUSTHEID TEGEN DUBBELE VERZENDING: elke item hieronder is op de server
 * idempotent te herhalen —
 *  - `stop-timer` (een timer die al online gestart was): een herhaalde
 *    `/time-entries/:id/stop` op een reeds gestopte registratie geeft een
 *    duidelijke `TIME_ENTRY_ALREADY_STOPPED`-fout, die hier als "al gelukt"
 *    behandeld wordt.
 *  - `manual-entry` (volledig offline gestart+gestopt, of de bestaande
 *    "manueel tijd toevoegen"-flow): draagt een `clientRequestId` — de
 *    backend (`TimeEntryService.createManual()`) geeft bij een herhaling
 *    dezelfde rij terug i.p.v. een tweede aan te maken.
 *  - de daaropvolgende "maak werkbon aan"-stap (bij beide soorten) geeft bij
 *    herhaling `WORK_ORDER_TIME_ENTRY_ALREADY_LINKED` terug, eveneens als
 *    "al gelukt" behandeld.
 * Zie de code-commentaren in apps/api/.../time-entry.service.ts en
 * work-order.service.ts voor de serverkant hiervan.
 */

const STORAGE_KEY = 'uurivo.outbox.v1';
const MAX_AUTO_RETRY_ATTEMPTS = 5;

export interface StopTimerPayload {
  timeEntryId: string;
  projectId: string;
  description: string | null;
}

export interface ManualEntryPayload {
  projectId: string;
  startedAt: string;
  endedAt: string;
  pausedMinutes: number;
  description: string | null;
  clientRequestId: string;
}

export type OutboxItemStatus = 'pending' | 'syncing' | 'failed';

export interface OutboxItem {
  id: string;
  createdAt: string;
  projectName: string;
  status: OutboxItemStatus;
  attempts: number;
  lastError: string | null;
  kind: 'stop-timer' | 'manual-entry';
  payload: StopTimerPayload | ManualEntryPayload;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readAll(): OutboxItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OutboxItem[];
  } catch {
    return [];
  }
}

function writeAll(items: OutboxItem[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Zie de toelichting bij localTimer.ts — bewust stil, de wachtrij blijft
    // dan enkel in het React-geheugen bestaan voor de rest van dit tabblad.
  }
  notify();
}

export function listOutbox(): OutboxItem[] {
  return readAll();
}

export function enqueueOutboxItem(
  kind: OutboxItem['kind'],
  payload: OutboxItem['payload'],
  projectName: string,
): OutboxItem {
  const item: OutboxItem = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    projectName,
    status: 'pending',
    attempts: 0,
    lastError: null,
    kind,
    payload,
  };
  writeAll([...readAll(), item]);
  void flushAll();
  return item;
}

function removeOutboxItem(id: string): void {
  writeAll(readAll().filter((item) => item.id !== id));
}

function updateOutboxItem(id: string, patch: Partial<OutboxItem>): void {
  writeAll(readAll().map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

/**
 * `fetch()` gooit een `TypeError` (geen HTTP-respons ontvangen — geen
 * netwerk, DNS-fout, CORS-blokkade e.d.) wanneer de server niet bereikt kon
 * worden. Een `ApiRequestError` betekent net het omgekeerde: de server wél
 * bereikt, en die gaf een expliciete fout terug (bv. validatiefout) — zoiets
 * hoort NIET stilzwijgend herhaald te worden (sectie 27: "geen automatische
 * eindeloze retry bij permanente validatiefouten").
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || !navigator.onLine;
}

function isAlreadyDoneError(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  return err.code === 'TIME_ENTRY_ALREADY_STOPPED' || err.code === 'WORK_ORDER_TIME_ENTRY_ALREADY_LINKED';
}

async function ensureWorkOrder(projectId: string, timeEntryId: string, description: string | null): Promise<void> {
  try {
    await workOrdersApi.create({ projectId, timeEntryIds: [timeEntryId], ...(description ? { description } : {}) });
  } catch (err) {
    if (isAlreadyDoneError(err)) return;
    throw err;
  }
}

async function flushOne(item: OutboxItem): Promise<'done' | 'retry-later' | 'permanent-error'> {
  try {
    if (item.kind === 'stop-timer') {
      const payload = item.payload as StopTimerPayload;
      try {
        await timeEntriesApi.stop(payload.timeEntryId, payload.description ?? undefined);
      } catch (err) {
        if (!isAlreadyDoneError(err)) throw err;
      }
      await ensureWorkOrder(payload.projectId, payload.timeEntryId, payload.description);
    } else {
      const payload = item.payload as ManualEntryPayload;
      const response = await timeEntriesApi.createManual({
        projectId: payload.projectId,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        pausedMinutes: payload.pausedMinutes,
        description: payload.description ?? undefined,
        clientRequestId: payload.clientRequestId,
      });
      await ensureWorkOrder(payload.projectId, response.timeEntry.id, payload.description);
    }
    return 'done';
  } catch (err) {
    if (isNetworkError(err)) return 'retry-later';
    const message = err instanceof ApiRequestError ? err.message : 'Onbekende fout bij synchroniseren.';
    updateOutboxItem(item.id, { status: 'failed', lastError: message });
    return 'permanent-error';
  }
}

let isFlushing = false;

/** Wordt aangeroepen bij app-start, bij een `online`-event, en periodiek zolang er items in de wachtrij staan (zie initOfflineSync). */
export async function flushAll(): Promise<void> {
  if (isFlushing) return;
  if (!navigator.onLine) return;
  isFlushing = true;
  try {
    // Sequentieel, niet parallel — vermijdt dat meerdere `createManual`-
    // aanroepen tegelijk om een nieuw werkbonnummer strijden vlak nadat de
    // verbinding net hersteld is, en houdt de volgorde van uitvoering.
    for (const item of readAll()) {
      if (item.status === 'failed' && item.attempts >= MAX_AUTO_RETRY_ATTEMPTS) continue;
      updateOutboxItem(item.id, { status: 'syncing', attempts: item.attempts + 1 });
      const result = await flushOne(item);
      if (result === 'done') {
        removeOutboxItem(item.id);
      } else if (result === 'retry-later') {
        updateOutboxItem(item.id, { status: 'pending' });
        break; // geen verbinding meer — geen zin om de rest ook te proberen
      }
      // 'permanent-error': flushOne zette zelf al status/lastError.
    }
  } finally {
    isFlushing = false;
  }
}

/** Handmatige "Opnieuw synchroniseren"-actie — negeert de auto-retry-limiet. */
export async function retryOutboxItem(id: string): Promise<void> {
  updateOutboxItem(id, { status: 'pending', attempts: 0, lastError: null });
  await flushAll();
}

export function discardOutboxItem(id: string): void {
  removeOutboxItem(id);
}

let initialized = false;

/** Eenmalig op te roepen bij app-start (zie main.tsx). */
export function initOfflineSync(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('online', () => void flushAll());
  // Fallback-polling — vooral nuttig omdat het 'online'-event op mobiel niet
  // altijd feilloos vuurt (bv. wisselen tussen wifi en mobiele data).
  window.setInterval(() => void flushAll(), 30_000);
  void flushAll();
}
