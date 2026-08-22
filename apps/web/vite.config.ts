import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
