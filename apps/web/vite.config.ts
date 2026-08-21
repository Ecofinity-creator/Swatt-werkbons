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
});
