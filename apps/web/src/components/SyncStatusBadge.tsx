import { useState } from 'react';
import { discardOutboxItem, retryOutboxItem } from '../offline/outbox';
import { useOutbox } from '../hooks/useOutbox';

/**
 * Offline-statusindicator (sectie 16: "Toon duidelijke status: 🟢
 * Gesynchroniseerd / 🟠 Wacht op synchronisatie / 🔴 Synchronisatie
 * mislukt"). Toont zichzelf bewust NIET wanneer alles gesynchroniseerd én
 * online is — met de mobile-first-regel "maximaal 1 primaire actie per
 * scherm" (sectie 21) voegt een altijd-zichtbare "alles OK"-badge weinig toe
 * en leidt enkel af.
 */
export function SyncStatusBadge() {
  const { items, pendingCount, failedCount, isOnline } = useOutbox();
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);

  if (isOnline && items.length === 0) return null;

  const tone = failedCount > 0 ? 'red' : !isOnline || pendingCount > 0 ? 'amber' : 'green';
  const label =
    failedCount > 0
      ? `🔴 ${failedCount} registratie${failedCount === 1 ? '' : 's'} niet gesynchroniseerd`
      : !isOnline
        ? '🟠 Geen verbinding — wordt automatisch bewaard'
        : `🟠 ${pendingCount} wacht${pendingCount === 1 ? '' : 'en'} op synchronisatie`;

  const toneClasses =
    tone === 'red'
      ? 'border-red-800 bg-red-950 text-red-300'
      : tone === 'amber'
        ? 'border-amber-800 bg-amber-950 text-amber-300'
        : 'border-green-800 bg-green-950 text-green-300';

  return (
    <div className={`w-full rounded-lg border px-4 py-2 text-sm ${toneClasses}`}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span>{label}</span>
        <span className="text-xs underline">{expanded ? 'verbergen' : 'details'}</span>
      </button>
      {expanded && (
        <ul className="mt-3 flex flex-col gap-2">
          {items.length === 0 && <li className="text-xs opacity-80">Niets in de wachtrij.</li>}
          {items.map((item) => (
            <li key={item.id} className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{item.projectName}</span>
                <span className="opacity-70">{new Date(item.createdAt).toLocaleString('nl-BE')}</span>
              </div>
              {item.status === 'failed' && item.lastError && <p className="mt-1 text-red-300">{item.lastError}</p>}
              {item.status === 'failed' && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void retryOutboxItem(item.id)}
                    className="rounded border border-white/20 px-3 py-1.5 font-semibold"
                  >
                    Opnieuw synchroniseren
                  </button>
                  {confirmDiscardId === item.id ? (
                    <button
                      type="button"
                      onClick={() => {
                        discardOutboxItem(item.id);
                        setConfirmDiscardId(null);
                      }}
                      className="rounded border border-red-500 px-3 py-1.5 font-semibold text-red-300"
                    >
                      Bevestig: definitief verwijderen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDiscardId(item.id)}
                      className="rounded border border-white/20 px-3 py-1.5 text-neutral-300"
                    >
                      Verwijderen
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
