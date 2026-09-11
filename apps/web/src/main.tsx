import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { initOfflineSync } from './offline/outbox';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element niet gevonden in index.html');
}

// Offline-modus (sectie 16) — service worker voor de app-shell (deel 1) +
// de schrijf-wachtrij die opstart-, `online`- en periodieke sync doet
// (deel 3, zie offline/outbox.ts). `registerSW` is een no-op buiten een
// productiebuild (geen service worker in `npm run dev`, zie vite.config.ts).
registerSW({ immediate: true });
initOfflineSync();

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
