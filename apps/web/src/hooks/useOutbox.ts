import { useEffect, useState } from 'react';
import { listOutbox, subscribeOutbox, type OutboxItem } from '../offline/outbox';

export interface UseOutboxResult {
  items: OutboxItem[];
  pendingCount: number;
  failedCount: number;
  isOnline: boolean;
}

/** Reactieve view op de offline-wachtrij (sectie 16) + de browser-eigen online/offline-status. */
export function useOutbox(): UseOutboxResult {
  const [items, setItems] = useState<OutboxItem[]>(() => listOutbox());
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const unsubscribe = subscribeOutbox(() => setItems(listOutbox()));
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return {
    items,
    pendingCount: items.filter((item) => item.status !== 'failed').length,
    failedCount: items.filter((item) => item.status === 'failed').length,
    isOnline,
  };
}
