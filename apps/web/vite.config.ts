import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Offline-modus (sectie 16, backlog-extra 11/9/2026) — deel 1: de
    // "app-shell" (HTML/JS/CSS/iconen) offline beschikbaar maken via een
    // service worker, zodat de app zelf opent op een werf zonder bereik
    // i.p.v. een blanco/foutscherm te tonen. Het echte manifest.webmanifest
    // in public/ (met de Uurivo-iconen) blijft ongewijzigd de bron van
    // waarheid — `manifest: false` laat deze plugin enkel de service worker
    // genereren, niet nóg een manifest erbovenop.
    VitePWA({
      manifest: false,
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-192.png',
        'icon-maskable-512.png',
      ],
      // Enkel actief in een productiebuild (npm run build && npm run
      // preview) — tijdens `npm run dev` zou een service worker Vite's
      // eigen hot-reload-cyclus alleen maar in de weg zitten.
      devOptions: { enabled: false },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        // GET-only (POST/PUT laat Workbox hier sowieso ongemoeid) —
        // NetworkFirst: probeer altijd eerst een verse server-respons (max.
        // 4s), val pas terug op de laatst gekende cache als er geen bereik
        // is. Zo blijft "Mijn projecten"/de actieve timerstatus bruikbaar
        // (weliswaar mogelijk een beetje verouderd) wanneer een technieker
        // de app op de werf heropent zonder ontvangst.
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /^\/(projects|time-entries|work-orders|auth\/me)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'uurivo-api-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Lokaal: frontend op :5173, backend op :3000 — geen CORS-gedoe tijdens dev.
      '/auth': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  build: {
    commonjsOptions: {
      // `@swatt/shared-types` is een CJS-package (nodig zodat apps/api het
      // gewoon met `require`/`import` kan gebruiken — zie packages/shared-types/tsconfig.json).
      // npm workspaces linkt het via een symlink; Rollup's commonjs-plugin
      // herkent enkel bestanden waarvan het (symlink-opgeloste) pad
      // "node_modules" bevat als "een CJS-dependency om te converteren" —
      // onze workspace-package resolvet buiten node_modules (naar
      // packages/shared-types/dist/...), en werd zonder deze regel dus als
      // "gewone ESM-bron" behandeld terwijl het CJS is, met een bouwfout
      // ("X is not exported by ... dist/index.js") tot gevolg zodra de
      // frontend voor het eerst een echte waarde (i.p.v. enkel een type)
      // importeert (bv. `roleAtLeast`).
      include: [/shared-types/, /node_modules/],
    },
  },
});
